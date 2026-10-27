// SPDX-License-Identifier: MIT
//
// Moves the cluster's ACU floor between a business-hours value and zero, on a schedule.
//
// ## Why a schedule at all, when Aurora can already scale to zero
//
// Aurora Serverless v2 pauses on its own once the floor is 0 and the cluster has been idle, so at
// first glance a fixed floor of 0 would do the whole job. The problem is the wake-up. A paused
// cluster answers the first statement with `DatabaseResumingException` and takes several seconds to
// come back. The backend retries that correctly, so nothing breaks - but the person who clicked
// waits.
//
// Off-hours that is the right trade: nobody is clicking, and the cluster bills nothing. During
// business hours it is the wrong trade twice over. Staff hit a multi-second stall after any quiet
// stretch - lunch, a long meeting - and because the floor is what Aurora bills, a cluster that is
// genuinely in use all day costs the same whether the floor is 0 or 0.5.
//
// So: floor 0.5 from 09:00, floor 0 from 18:00 (Q11). Roughly $22/month instead of $70.
//
// ## Why EventBridge Scheduler's universal target rather than a Lambda
//
// This could be a nine-line Lambda. It is not, because a Lambda is a function, a role, a log group,
// a bundling step and a dependency to patch - five things to own in a system that two people
// maintain and only one of them knows AWS (Q17). The universal target calls `rds:ModifyDBCluster`
// directly from the Scheduler, so the only things to own are two schedules and a role.
//
// ## Two consequences worth knowing before changing this
//
// `ModifyDBCluster` with `ApplyImmediately` omitted still applies scaling-configuration changes
// immediately - serverless scaling config is not a pending-reboot parameter. It is passed anyway, so
// the intent is in the payload rather than in someone's memory of RDS semantics.
//
// The schedules are the ONLY thing that sets the floor after deployment. That means
// `serverlessV2MinCapacity` in NeotmsDatabase is the value at creation and after that it drifts from
// what is really running, and a `cdk deploy` outside business hours will briefly reset the floor to
// 0.5 until the 18:00 schedule fires. Harmless, but it does mean the console and the template
// disagree, and that is worth knowing before concluding something is broken.

import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rds from "aws-cdk-lib/aws-rds";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import { Construct } from "constructs";
import { NeotmsStageConfig } from "../config/NeotmsConfig.js";

export interface NeotmsAcuSchedulerProps {
  readonly config: NeotmsStageConfig;
  readonly cluster: rds.DatabaseCluster;
}

export class NeotmsAcuScheduler extends Construct {
  constructor(scope: Construct, id: string, props: NeotmsAcuSchedulerProps) {
    super(scope, id);
    const { config, cluster } = props;
    const cap = config.capacity;

    /*
     * One role for both schedules.
     *
     * Scoped to this cluster's ARN only. `rds:ModifyDBCluster` on `*` would let the schedule resize,
     * rename or disable deletion protection on every cluster in the account - including, eventually,
     * ones that have nothing to do with this project.
     */
    const schedulerRole = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": cdk.Stack.of(this).account },
        },
      }),
      description: "Lets EventBridge Scheduler change the NEOTMS cluster's ACU floor",
    });
    const modifyPolicy = new iam.PolicyStatement({
      actions: ["rds:ModifyDBCluster"],
      resources: [cluster.clusterArn],
    });

    /*
     * A group, so both schedules show up together and can be disabled together.
     *
     * That matters during a maintenance window or a migration run: deleting the group's schedules
     * one at a time risks leaving the floor at 0 while a bulk load is running, which turns every
     * batch into a resume.
     */
    const group = new scheduler.ScheduleGroup(this, "Group", {
      scheduleGroupName: `${config.resourcePrefix}-acu`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const makeSchedule = (
      scheduleId: string,
      hourKst: number,
      minCapacity: number,
      description: string,
    ) => {
      /*
       * Scheduled in Asia/Seoul, not UTC.
       *
       * Korea has no daylight saving, so `cron(0 0 ? * MON-FRI *)` in UTC would be correct forever.
       * Writing it in KST anyway means the number in the code is the number a Korean colleague
       * reads on the clock - no mental 9-hour offset when someone asks why the database was slow at
       * 09:00. The payload below is passed as a raw JSON string because the universal target speaks
       * the RDS API's own shape, not CDK's.
       */
      new scheduler.Schedule(this, scheduleId, {
        scheduleName: `${config.resourcePrefix}-acu-${scheduleId.toLowerCase()}`,
        scheduleGroup: group,
        description,
        // Monday-Friday only. A weekend floor of 0.5 would be ~29% of the monthly compute bill paid
        // for days when the office is shut.
        schedule: scheduler.ScheduleExpression.cron({
          minute: "0",
          hour: String(hourKst),
          weekDay: "MON-FRI",
          timeZone: cdk.TimeZone.ASIA_SEOUL,
        }),
        target: new targets.Universal({
          service: "rds",
          action: "modifyDBCluster",
          role: schedulerRole,
          policyStatements: [modifyPolicy],
          input: scheduler.ScheduleTargetInput.fromObject({
            DbClusterIdentifier: cluster.clusterIdentifier,
            ApplyImmediately: true,
            ServerlessV2ScalingConfiguration: {
              MinCapacity: minCapacity,
              MaxCapacity: cap.maxAcu,
              /*
               * Resent on every change, because omitting it from a ModifyDBCluster that includes a
               * ServerlessV2ScalingConfiguration clears it - and an unset auto-pause duration means
               * a floor of 0 never actually pauses, which silently undoes the entire saving this
               * construct exists for.
               */
              SecondsUntilAutoPause: cap.secondsUntilAutoPause,
            },
          }),
          /*
           * A missed window must not be "caught up" later.
           *
           * Scheduler's default retry would re-fire a missed 18:00 drop at, say, 09:10 the next
           * morning - setting the floor to 0 exactly as people start work. One attempt, no retry,
           * and the next scheduled firing fixes it.
           */
          retryAttempts: 0,
          maxEventAge: cdk.Duration.minutes(5),
        }),
      });
    };

    makeSchedule(
      "BusinessHoursStart",
      cap.businessHoursStartHourKst,
      cap.businessHoursMinAcu,
      `Raise the ACU floor to ${cap.businessHoursMinAcu} at ${cap.businessHoursStartHourKst}:00 KST`,
    );
    makeSchedule(
      "BusinessHoursEnd",
      cap.businessHoursEndHourKst,
      cap.offHoursMinAcu,
      `Drop the ACU floor to ${cap.offHoursMinAcu} at ${cap.businessHoursEndHourKst}:00 KST`,
    );
  }
}
