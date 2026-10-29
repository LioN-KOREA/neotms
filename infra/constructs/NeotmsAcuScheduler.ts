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
// Off-hours that is the right trade: nobody is clicking, and the cluster bills nothing. While
// people are working it is the wrong trade twice over. Staff hit a multi-second stall after any
// quiet stretch - lunch, a long meeting - and because the floor is what Aurora bills, a cluster that
// is genuinely in use all day costs the same whether the floor is 0 or 0.5.
//
// So: floor 0.5 from 06:00, floor 0 from 00:00, EVERY day.
//
// ## Why 06:00-00:00 and not 09:00-18:00
//
// This construct used to hold the floor over the official working day, Monday to Friday, for roughly
// $20/month of compute. That was wrong, and it was wrong in the way infrastructure mistakes usually
// are - it worked for the average user and failed for the people least likely to file a usable bug
// report. Project managers arrive as early as 06:30 and work as late as 23:00, and some work
// weekends against delivery deadlines. Every one of those sessions began with a resume stall, which
// from the outside is indistinguishable from "the system is broken again".
//
// At Seoul's $0.20 per ACU-hour the numbers are:
//
//   09:00-18:00 Mon-Fri   ~$20/month compute   stalls every early, late and weekend session
//   06:00-00:00 every day ~$55/month compute   no stall for anyone who could be working
//   flat 0.5 ACU 24/7     ~$73/month compute   no stall ever, including for nobody
//
// Add roughly $7/month of storage, backup and I/O to each. The middle row is the one bought here:
// the six hours it gives up, 00:00-06:00, contain no human and no scheduled job, so the only thing
// that ever pays the resume cost is the first connection of the morning - and the 06:00 schedule
// itself is that connection, half an hour ahead of the earliest arrival.
//
// Note what this does NOT buy: a floor of 0.5 is not a performance floor, it is an availability one.
// The cluster still scales up to `maxAcu` under load, and it still stalls if someone somehow starts
// work at 05:00. The claim is only that nobody who could reasonably be working meets a paused
// cluster.
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
// what is really running, and a `cdk deploy` between 00:00 and 06:00 will briefly reset the floor to
// 0.5 until the next midnight schedule fires. Harmless, but it does mean the console and the
// template disagree, and that is worth knowing before concluding something is broken.

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

/** `0` -> `"00"`, so a schedule's description reads as a clock time rather than as `0:00`. */
const pad = (hour: number) => String(hour).padStart(2, "0");

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
       * Checked here rather than left to CloudFormation.
       *
       * The obvious way to write "the floor comes down at midnight" is `24`, and EventBridge cron
       * hours are 0-23 - so that spelling is rejected, but only at deploy time, by a `ValidationError`
       * naming a schedule expression rather than the config field that produced it. Non-integers fail
       * the same way with an even less helpful message.
       */
      if (!Number.isInteger(hourKst) || hourKst < 0 || hourKst > 23) {
        throw new Error(
          `ACU schedule hour must be an integer 0-23 (KST) but was ${hourKst}. ` +
            `Midnight is 0, not 24 - see NeotmsCapacityConfig.staffedHoursEndHourKst.`,
        );
      }

      /*
       * Scheduled in Asia/Seoul, not UTC.
       *
       * Korea has no daylight saving, so a fixed UTC expression would be correct forever. Writing it
       * in KST anyway means the number in the code is the number a Korean colleague reads on the
       * clock - no mental 9-hour offset when someone asks why the database was slow at 06:00. The
       * payload below is passed as a raw JSON string because the universal target speaks the RDS
       * API's own shape, not CDK's.
       */
      new scheduler.Schedule(this, scheduleId, {
        scheduleName: `${config.resourcePrefix}-acu-${scheduleId.toLowerCase()}`,
        scheduleGroup: group,
        description,
        /*
         * Every day, including weekends - `weekDay` omitted, which CDK renders as `0 H * * ? *`.
         *
         * It used to be `MON-FRI`, on the grounds that a weekend floor is ~29% of the compute bill
         * paid for days when the office is shut. The office being shut turned out not to mean the
         * same thing as nobody working: PMs do pick up weekend deliveries, and for them the saving
         * was funded entirely by a stall on the one day there is nobody around to explain it.
         */
        schedule: scheduler.ScheduleExpression.cron({
          minute: "0",
          hour: String(hourKst),
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
           * Scheduler's default retry would re-fire a missed 00:00 drop at, say, 06:10 - setting the
           * floor to 0 exactly as people start work. One attempt, no retry, and the next scheduled
           * firing fixes it.
           */
          retryAttempts: 0,
          maxEventAge: cdk.Duration.minutes(5),
        }),
      });
    };

    makeSchedule(
      "StaffedHoursStart",
      cap.staffedHoursStartHourKst,
      cap.staffedHoursMinAcu,
      `Raise the ACU floor to ${cap.staffedHoursMinAcu} at ` +
        `${pad(cap.staffedHoursStartHourKst)}:00 KST, daily`,
    );
    makeSchedule(
      "StaffedHoursEnd",
      cap.staffedHoursEndHourKst,
      cap.offHoursMinAcu,
      `Drop the ACU floor to ${cap.offHoursMinAcu} at ` +
        `${pad(cap.staffedHoursEndHourKst)}:00 KST, daily`,
    );
  }
}
