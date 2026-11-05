/**
 * O8 (5 Nov 2026) — the Daily tasks page saves exactly what the server keeps (functions/src/dailyTasks.ts
 * `sanitizeDailyTasksConfig`): off unless exactly true, unknown measures and rewardless tasks dropped, host measures
 * made the hosts', numbers clamped, beans only for host tasks, the same limits and the same measures as the server.
 */
import { DAILY_TASKS_LIMITS, METRIC_IDS, droppedOnSave, sanitizeDailyTasks, taskIdFrom } from './dailyTasksSettings'

let checks = 0
const failures: string[] = []
function eq(label: string, got: unknown, want: unknown): void {
  checks += 1
  if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${label}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`)
}

eq('nothing stored: off, no tasks', sanitizeDailyTasks(undefined), { enabled: false, tasks: [] })
eq('a truthy string is not "on"', sanitizeDailyTasks({ enabled: 'true' }).enabled, false)
const one = sanitizeDailyTasks({ enabled: true, tasks: [{ id: 'gifts5', title: '  Send   5 gifts ', metric: 'send_gifts', target: 5, rewardDiamonds: 20 }] })
eq('a good task is kept, title tidied, everyone by default', one.tasks[0], { id: 'gifts5', title: 'Send 5 gifts', audience: 'everyone', metric: 'send_gifts', target: 5, rewardDiamonds: 20, rewardBeans: 0, enabled: true, order: 0 })
eq('a host measure makes the task the hosts\'', sanitizeDailyTasks({ tasks: [{ id: 'live', metric: 'live_minutes', target: 30, rewardBeans: 100, audience: 'users' }] }).tasks[0].audience, 'hosts')
eq('beans only for host tasks', sanitizeDailyTasks({ tasks: [{ id: 'g', metric: 'send_gifts', rewardDiamonds: 5, rewardBeans: 99 }] }).tasks[0].rewardBeans, 0)
eq('no reward, no task', sanitizeDailyTasks({ tasks: [{ id: 'g', metric: 'send_gifts', rewardDiamonds: 0 }] }).tasks.length, 0)
eq('unknown measure dropped', sanitizeDailyTasks({ tasks: [{ id: 'g', metric: 'hack', rewardDiamonds: 5 }] }).tasks.length, 0)
eq('bad and repeated ids dropped', sanitizeDailyTasks({ tasks: [{ id: 'Bad Id', metric: 'send_gifts', rewardDiamonds: 5 }, { id: 'a', metric: 'send_gifts', rewardDiamonds: 5 }, { id: 'a', metric: 'send_gifts', rewardDiamonds: 5 }] }).tasks.length, 1)
eq('rewards clamped to the limits', sanitizeDailyTasks({ tasks: [{ id: 'g', metric: 'send_gifts', rewardDiamonds: 10 ** 9 }] }).tasks[0].rewardDiamonds, DAILY_TASKS_LIMITS.maxRewardDiamonds)
eq('the daily check-in target is always 1', sanitizeDailyTasks({ tasks: [{ id: 'c', metric: 'daily_checkin', target: 7, rewardDiamonds: 5 }] }).tasks[0].target, 1)
eq('ids from titles are valid and unique', [taskIdFrom('Send 5 gifts!', new Set()), taskIdFrom('Send 5 gifts', new Set(['send-5-gifts']))], ['send-5-gifts', 'send-5-gifts-2'])
eq('droppedOnSave counts what the server would drop', droppedOnSave([{ id: 'a', metric: 'send_gifts', rewardDiamonds: 1 }, { id: 'b', metric: 'send_gifts', rewardDiamonds: 0 }]), 1)

const server = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'functions', 'src', 'dailyTasks.ts'), 'utf8') as string
eq('the server has the same limits', ['maxTasks: 30', 'maxRewardDiamonds: 10_000', 'maxRewardBeans: 100_000', 'titleMax: 60'].every((t) => server.includes(t)), true)
eq('the server measures the same things', METRIC_IDS.every((m) => server.includes(`  ${m}: {`)), true)

if (failures.length) {
  console.error(`${failures.length} of ${checks} daily tasks settings checks FAILED:`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log(`All ${checks} daily tasks settings checks passed.`)
