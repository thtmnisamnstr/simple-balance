import {
  addDays, daysInMonth, occurrenceAt, nextOccurrenceAfter, occurrencesBetween,
  scheduleCursor, weekdayOf, weekdayOfMonth,
  type RecurrenceRule, type RecurrenceFrequency, type RecurrenceMonthPolicy,
  type RecurrenceWeekendPolicy, type RecurrencePosition,
} from "./src/shared/recurrence-dates.js";
import { nextNotificationAfter, notificationIsDue, firstNotificationDate, type NotificationRule } from "./src/server/services/notifications.js";

const fails: string[] = [];
const fail = (m: string) => { if (fails.length < 60) fails.push(m); };

const freqs: RecurrenceFrequency[] = ["daily", "weekly", "monthly", "yearly"];
const months: RecurrenceMonthPolicy[] = ["last_day", "skip"];
const weekends: RecurrenceWeekendPolicy[] = ["allow", "skip", "previous_business_day", "next_business_day"];
const positions: (RecurrencePosition | null)[] = [null,
  { ordinal: 1, weekday: 0 }, { ordinal: 2, weekday: 2 }, { ordinal: 4, weekday: 5 }, { ordinal: -1, weekday: 6 }];
const anchors = [
  "2023-01-31","2024-01-31","2024-02-29","2024-02-28","2023-02-28","2024-12-31","2024-11-30",
  "2024-03-01","2024-06-15","2019-12-30","2024-08-31","2024-04-30","2100-02-28","2000-02-29",
];
const intervals = [1,2,3,7,12,13];

function monthIndex(d: string) { return Number(d.slice(0,4))*12 + Number(d.slice(5,7)) - 1; }

let ruleCount = 0;
const allRules: RecurrenceRule[] = [];
for (const frequency of freqs)
 for (const interval of intervals)
  for (const anchorDate of anchors)
   for (const monthPolicy of months)
    for (const weekendPolicy of weekends)
     for (const position of positions) {
       if (position && (frequency === "daily" || frequency === "weekly")) continue;
       allRules.push({ frequency, interval, anchorDate, monthPolicy, weekendPolicy, position });
     }

const N = 60;
for (const rule of allRules) {
  ruleCount++;
  const seq = Array.from({ length: N }, (_, n) => occurrenceAt(rule, n));
  // strictly increasing, no repeats
  for (let n = 1; n < N; n++) {
    if (!(seq[n].occurrenceDate > seq[n-1].occurrenceDate)) {
      fail(`not strictly increasing: ${JSON.stringify(rule)} n=${n} ${seq[n-1].occurrenceDate} -> ${seq[n].occurrenceDate}`);
      break;
    }
  }
  // interval respected
  for (let n = 1; n < N; n++) {
    const a = seq[n-1].occurrenceDate, b = seq[n].occurrenceDate;
    if (rule.frequency === "daily") {
      if (addDays(a, rule.interval) !== b) fail(`daily step wrong ${JSON.stringify(rule)} ${a}->${b}`);
    } else if (rule.frequency === "weekly") {
      if (addDays(a, rule.interval*7) !== b) fail(`weekly step wrong ${JSON.stringify(rule)} ${a}->${b}`);
    } else if (rule.frequency === "monthly") {
      if (monthIndex(b) - monthIndex(a) !== rule.interval) fail(`monthly step wrong ${JSON.stringify(rule)} ${a}->${b}`);
    } else {
      if (Number(b.slice(0,4)) - Number(a.slice(0,4)) !== rule.interval) fail(`yearly step wrong ${JSON.stringify(rule)} ${a}->${b}`);
    }
  }
  // positioned rule ignores anchor day
  if (rule.position) {
    const p = rule.position;
    for (const day of [1, 7, 15, 28]) {
      const alt: RecurrenceRule = { ...rule, anchorDate: `${rule.anchorDate.slice(0,8)}${String(day).padStart(2,"0")}` };
      for (let n = 0; n < 8; n++) {
        if (occurrenceAt(alt, n).occurrenceDate !== seq[n].occurrenceDate) {
          fail(`positioned rule reads anchor day: ${JSON.stringify(rule)} alt=${alt.anchorDate} n=${n} ${occurrenceAt(alt,n).occurrenceDate} vs ${seq[n].occurrenceDate}`);
          break;
        }
      }
    }
    // and the date really is the ordinal weekday
    for (let n = 0; n < 8; n++) {
      if (weekdayOf(seq[n].occurrenceDate) !== p.weekday) fail(`positioned wrong weekday ${JSON.stringify(rule)} ${seq[n].occurrenceDate}`);
    }
  }
  // nextOccurrenceAfter / occurrencesBetween agree with brute force
  const probeAfters = [addDays(rule.anchorDate, -1), rule.anchorDate, seq[3].occurrenceDate,
     addDays(seq[3].occurrenceDate, 1), addDays(seq[3].occurrenceDate, -1), seq[10].occurrenceDate,
     "1999-01-01", "2038-01-01"];
  for (const after of probeAfters) {
    const brute = seq.find((o) => o.occurrenceDate > after);
    if (!brute) continue;
    const got = nextOccurrenceAfter(rule, after);
    if (got.occurrenceDate !== brute.occurrenceDate) {
      fail(`nextOccurrenceAfter wrong ${JSON.stringify(rule)} after=${after} got=${got.occurrenceDate} want=${brute.occurrenceDate}`);
    }
    const through = seq[Math.min(N-1, 20)].occurrenceDate;
    const bruteList = seq.filter((o) => o.occurrenceDate > after && o.occurrenceDate <= through).slice(0, 5);
    const gotList = occurrencesBetween(rule, after, through, 5);
    if (JSON.stringify(bruteList) !== JSON.stringify(gotList)) {
      fail(`occurrencesBetween wrong ${JSON.stringify(rule)} after=${after} through=${through}\n  got ${JSON.stringify(gotList)}\n want ${JSON.stringify(bruteList)}`);
    }
  }
}
console.log(`swept ${ruleCount} rules`);

// month/weekend policy correctness spot checks
{
  const r: RecurrenceRule = { frequency: "monthly", interval: 1, anchorDate: "2024-01-31", monthPolicy: "skip", weekendPolicy: "allow", position: null };
  const got = Array.from({length:14},(_,n)=>occurrenceAt(r,n));
  console.log("monthly 31st skip:", got.map(o=>`${o.occurrenceDate}/${o.postedDate ?? "-"}`).join(" "));
}
{
  const r: RecurrenceRule = { frequency: "yearly", interval: 1, anchorDate: "2024-02-29", monthPolicy: "skip", weekendPolicy: "allow", position: null };
  console.log("yearly leap-day skip:", Array.from({length:6},(_,n)=>{const o=occurrenceAt(r,n); return `${o.occurrenceDate}/${o.postedDate ?? "-"}`;}).join(" "));
}

// ---- notifications ----
console.log("--- notifications ---");
const nr = (o: Partial<NotificationRule>): NotificationRule => ({
  frequency: "monthly", interval: 1, anchorDate: "2024-01-31",
  monthPolicy: "last_day", weekendPolicy: "allow", position: null, ...o });

console.log("one-off, cursor null:", JSON.stringify(nextNotificationAfter(nr({frequency:null, anchorDate:"2024-03-05"}), null)));
console.log("one-off, cursor set :", JSON.stringify(nextNotificationAfter(nr({frequency:null, anchorDate:"2024-03-05"}), "2024-03-05")));

const skip31 = nr({ frequency: "monthly", anchorDate: "2024-01-31", monthPolicy: "skip" });
console.log("monthly 31st skip, first:", JSON.stringify(nextNotificationAfter(skip31, null)));
console.log("monthly 31st skip, after 2024-01-31:", JSON.stringify(nextNotificationAfter(skip31, "2024-01-31")));
console.log("firstNotificationDate monthly31 skip:", firstNotificationDate(skip31));

// weekly landing on Saturday with weekendPolicy skip -> every occurrence skipped forever
const satSkip = nr({ frequency: "weekly", anchorDate: "2024-03-02", weekendPolicy: "skip" }); // 2024-03-02 is a Saturday
console.log("2024-03-02 weekday:", weekdayOf("2024-03-02"));
console.log("weekly Saturday + skip, first:", JSON.stringify(nextNotificationAfter(satSkip, null)));
console.log("firstNotificationDate weekly-sat-skip:", firstNotificationDate(satSkip));

// yearly on a Sunday with skip
const sunSkip = nr({ frequency: "yearly", anchorDate: "2024-09-01", weekendPolicy: "skip" });
console.log("2024-09-01 weekday:", weekdayOf("2024-09-01"));
console.log("yearly Sunday + skip, first:", JSON.stringify(nextNotificationAfter(sunSkip, null)));

// due comparison
console.log("isDue past date:", notificationIsDue("2024-03-01","23:00","2024-03-05","00:01"));
console.log("isDue today early:", notificationIsDue("2024-03-05","08:30","2024-03-05","07:00"));
console.log("isDue today late:", notificationIsDue("2024-03-05","08:30","2024-03-05","09:00"));
console.log("isDue future:", notificationIsDue("2024-03-06","08:30","2024-03-05","09:00"));

console.log("--- scheduleCursor ---");
console.log(scheduleCursor({ proposesFrom: "2024-03-10", lastOccurrenceDate: null }));
console.log(scheduleCursor({ proposesFrom: "2024-03-10", lastOccurrenceDate: "2024-01-01" }));

if (fails.length) { console.log(`\nFAILURES (${fails.length}):`); for (const f of fails) console.log(" - " + f); }
else console.log("\nno property failures");
