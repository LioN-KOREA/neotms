// SPDX-License-Identifier: MIT
//
// Custom CloudWatch metrics for conditions that should raise an alarm.
//
// Why these are NOT written through lpxWriteLogToQueue: that path goes to SQS and then to
// DynamoDB, so it is readable only by someone who opens the console and looks. An alarm has to be
// able to fire while nobody is looking, and it has to keep working when the log pipeline itself is
// the thing that is broken.
//
// Why EMF (embedded metric format) rather than a CloudWatch MetricFilter in the stack:
//
//   - A MetricFilter is an `AWS::Logs::MetricFilter`, which requires its log group to EXIST at
//     deploy time. A Lambda's log group is created on first invocation, so a fresh stack would
//     either fail on that resource or need the log group pre-created. Reaching for CDK's
//     `fn.logGroup` getter pre-creates it, but it also attaches a LogRetention custom resource and
//     RESETS the group's retention — a side effect nobody asked for while adding an alarm.
//   - EMF needs no infrastructure at all: a structured line on stdout is converted to a metric by
//     CloudWatch Logs itself. No IAM, no resource, nothing that can fail during a deploy.
//
// The cost is one custom metric ($0.30/month), which a MetricFilter would also have cost.
//
// A metric emitted this way publishes a datapoint only when the condition occurs, so an alarm on
// it must use treatMissingData: NOT_BREACHING — no datapoints means the condition is not
// happening, which is the good case, not an unknown one.

/** Namespace for every metric in this file. Must match LPX_METRIC_NAMESPACE in LpxStack. */
export const LPX_METRIC_NAMESPACE = "LPX/Auth";

/**
 * The JWKS endpoint could not serve a single key.
 *
 * The highest-impact failure mode in the system: every integrated app verifies tokens against this
 * document, so no keys means every app fails verification at once, and it fails for callers who
 * are not in a position to tell us about it.
 */
export const LPX_METRIC_JWKS_UNAVAILABLE = "JwksUnavailable";

/**
 * How old the signing key currently in use is, in days.
 *
 * A gauge rather than a count: the alarm on it asks "is rotation due", which is a question about
 * the latest value and not about a sum over a period. Published once per run of the key-health
 * check, so any alarm on it needs a period at least as long as that schedule.
 */
export const LPX_METRIC_ACTIVE_KEY_AGE_DAYS = "ActiveKeyAgeDays";

/**
 * Something about the signing keys is wrong: a key is disabled, undescribable, or its published
 * JWK does not match what KMS holds.
 *
 * ONE metric for all of those, because the response to each is the same — read the log line, which
 * names the specific key and the specific fault. Separate metrics would multiply the alarms
 * without adding anything an operator would act on differently.
 */
export const LPX_METRIC_KEY_HEALTH_FAILURES = "KeyHealthFailures";

/**
 * Emit one metric value, with no dimensions.
 *
 * Dimensionless on purpose. A dimension is useful for slicing a metric you watch on a dashboard;
 * these are watched by an alarm that has exactly one question to answer ("is this happening at
 * all?"), and every dimension added to an alarmed metric is another combination that can silently
 * fail to appear.
 *
 * Fire-and-forget by nature: writing to stdout cannot fail in a way worth handling, and a
 * swallowed metric must never turn into a failed request.
 */
export function lpxEmitMetric(metricName: string, value: number, unit = "Count"): void {
    try {
        console.log(JSON.stringify({
            _aws: {
                Timestamp: Date.now(),
                CloudWatchMetrics: [{
                    Namespace: LPX_METRIC_NAMESPACE,
                    // An empty dimension set publishes the metric without dimensions.
                    Dimensions: [[]],
                    Metrics: [{ Name: metricName, Unit: unit }],
                }],
            },
            [metricName]: value,
        }));
    } catch {
        // Unreachable in practice, and deliberately silent: a failure to emit a metric must not
        // become a failure to answer the request the metric was about.
    }
}

/** "This happened once." The common case, and the reason the value defaults. */
export function lpxEmitCountMetric(metricName: string, value = 1): void {
    lpxEmitMetric(metricName, value, "Count");
}
