/**
 * Pure view logic for the Agent Fleet herdr pane — no React, no DOM, no ctx.
 *
 * The Desktop loader evaluates `plugin.js` as a standalone blob: relative
 * imports cannot resolve, so the plugin file must be self-contained. The block
 * between the SHARED markers below is therefore copied verbatim into
 * `plugin.js`, and `presentation.test.js` fails if the two copies drift.
 *
 * Everything here answers one question: what does a human see, and does it read
 * as the state it actually is? The probe taught that the hard way — success and
 * failure rendered as one long line of raw JSON, and the success read as a
 * stack trace. Hence `{ tone, headline, detail }` triples instead of formatted
 * strings, and hence "herdr is not answering" and "herdr answered, nobody is
 * running" being two different sentences.
 */

// <<< SHARED WITH plugin.js — keep byte-identical >>>

// StatusDot tones. `detached` and `unknown` are both "we can't see it", but
// they arrive from different places: detached = herdr answered and had no pane,
// unknown = herdr did not answer at all.
const STATE_TONE = { working: 'good', idle: 'muted', blocked: 'warn', detached: 'bad', unknown: 'bad' }

const STATE_LABEL = {
  working: 'working',
  idle: 'idle',
  blocked: 'needs answer',
  detached: 'detached',
  unknown: 'unknown'
}

// A dispatch is a prompt this pane handed to a peer. `failed` never reached the
// peer at all; `error` reached it and came back refused; `timeout` reached it
// and was never answered. Three different things to do about it, so three
// words.
const DISPATCH_TONE = { pending: 'muted', answered: 'good', error: 'bad', failed: 'bad', timeout: 'warn' }

const DISPATCH_LABEL = {
  pending: 'working on it',
  answered: 'answered',
  error: 'refused',
  failed: 'not delivered',
  timeout: 'no answer'
}

function stateTone(state) {
  return STATE_TONE[state] ?? 'bad'
}

function stateLabel(state) {
  return STATE_LABEL[state] ?? 'unknown'
}

function countSessions(projects) {
  return projects.reduce((total, group) => total + (group.sessions?.length ?? 0), 0)
}

function countWaiting(projects) {
  return projects.reduce((total, group) => total + (group.sessions ?? []).filter(s => s.needs_answer).length, 0)
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** Seconds to something a glance can read: `45s`, `3m12s`, `2h13m`, `3d4h`.
 *
 *  Seconds survive up to the hour mark because that is the range a human is
 *  watching a turn in; above it, nobody counts seconds. An unusable input —
 *  the backend sends `null` for a timestamp it could not parse — returns the
 *  empty string, so a caller that forwards it renders nothing rather than
 *  "0s", which would be a claim. */
function formatAge(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return ''
  const whole = Math.floor(seconds)
  if (whole < 60) return `${whole}s`
  if (whole < 3600) return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`
  if (whole < 86400) return `${Math.floor(whole / 3600)}h${Math.floor((whole % 3600) / 60)}m`

  return `${Math.floor(whole / 86400)}d${Math.floor((whole % 86400) / 3600)}h`
}

/** Why a row cannot be seen, or why it should not be trusted — in a sentence.
 *
 *  `detached` used to be the end of the story, which made a herdr that was up
 *  but empty look exactly like a peer that had left its pane. `herdrPanes` is
 *  the pane count from the payload; `undefined` means the payload predates it,
 *  and the answer degrades to the older, vaguer sentence rather than inventing
 *  a number. */
function sessionNote(session, herdrPanes) {
  const state = session.state ?? 'unknown'

  // Checked before the state, because a stopped heartbeat says something about
  // the PROCESS, while `detached` only says something about our view of it.
  if (session.stale) {
    const age = formatAge(session.heartbeat_age_s)

    return age ? `no heartbeat for ${age}` : 'no heartbeat'
  }

  if (state === 'detached') {
    if (herdrPanes === 0) return 'alive — herdr reports no panes at all'
    if (typeof herdrPanes === 'number') return `alive — none of ${plural(herdrPanes, 'herdr pane')} reports it`

    return 'alive, but no herdr pane reports it'
  }

  if (state === 'unknown') return 'herdr did not answer — state unknown'

  return ''
}

/** The pane's own status line: `{ kind, tone, headline, detail, projects }`.
 *
 *  `kind` drives which body renders; `tone`/`headline`/`detail` are what the
 *  header shows in every case, so the state is legible without reading the
 *  payload. */
function presentSessions(value) {
  const projects = value?.projects ?? []
  const dispatches = value?.dispatches ?? []
  // Every branch below spreads this. The renderer maps over `projects` and
  // `dispatches` unconditionally, so a branch that forgets one is not a missing
  // list — it is a blank pane reading "failed to render". `herdrPanes` rides
  // along because it belongs to the payload, not to any one row, and the rows
  // are what need it.
  const base = { projects, dispatches, herdrPanes: value?.herdr_panes }

  if (value?.error) {
    const message = String(value.error)
    // The enable gate is middleware in front of routing (web_server.py:576), so
    // a disabled plugin and a missing route are the same 404. Fail closed and
    // calm: this is a configuration answer, not a crash.
    const notEnabled = /\b404\b/.test(message)

    return {
      ...base,
      kind: 'unavailable',
      tone: 'muted',
      headline: notEnabled ? 'Fleet backend not enabled' : 'Fleet backend unavailable',
      detail: notEnabled
        ? 'hermes plugins enable agent-fleet-herdr && hermes gateway restart'
        : message.slice(0, 200),
      projects: []
    }
  }

  if (value?.loading) {
    return { ...base, kind: 'loading', tone: 'muted', headline: 'Reading the fleet…', detail: '' }
  }

  const herdrDown = value?.herdr === false

  if (projects.length === 0) {
    return {
      ...base,
      kind: 'empty',
      tone: 'muted',
      headline: 'No live Agent Fleet sessions',
      // Two genuinely different situations, two different sentences.
      detail: herdrDown ? 'herdr is not answering either' : 'Nothing registered in the coms registry'
    }
  }

  const waiting = countWaiting(projects)

  return {
    ...base,
    kind: 'projects',
    tone: waiting > 0 ? 'warn' : 'good',
    headline:
      waiting > 0
        ? `${plural(waiting, 'agent')} waiting for you`
        : `${plural(countSessions(projects), 'session')} in ${plural(projects.length, 'project')}`,
    detail: herdrDown ? 'herdr not answering — states unknown' : ''
  }
}

/** One sent prompt, already decided. `state` is deliberately absent: whether a
 *  peer sits in a herdr pane has nothing to do with whether it can be asked —
 *  coms goes to the peer's own socket — so a `detached` agent is a perfectly
 *  good target and must not be rendered as an unavailable one. */
function presentDispatch(dispatch, nowMs = Date.now()) {
  const status = dispatch.status ?? 'pending'
  const label = DISPATCH_LABEL[status] ?? status
  // A turn takes minutes. Without this, `working on it` is indistinguishable
  // from `stuck` for the entire time it matters. A finished dispatch keeps the
  // time it TOOK — `Date.parse` of a missing timestamp is NaN, which is falsy,
  // so an unanswered one ages against now.
  const sentMs = Date.parse(dispatch.sent_at ?? '')
  const untilMs = Date.parse(dispatch.answered_at ?? '') || nowMs
  const age = Number.isFinite(sentMs) ? formatAge((untilMs - sentMs) / 1000) : ''

  return {
    id: dispatch.msg_id,
    target: `${dispatch.name} · ${dispatch.project}`,
    tone: DISPATCH_TONE[status] ?? 'bad',
    label,
    age,
    prompt: dispatch.prompt ?? '',
    // The reason a failure happened is more use than the answer that is absent.
    body: dispatch.response ?? dispatch.detail ?? '',
    pending: status === 'pending',
    ariaLabel: `${dispatch.prompt ?? ''} — ${label}${age ? ` after ${age}` : ''} by ${dispatch.name}`
  }
}

/** The row a `(project, name)` selection points at, or null.
 *
 *  The selection is a pair of strings held by the pane; the row it names is
 *  re-found in every payload rather than copied at click time, so an action
 *  offered for it is decided on what is true now, not on what was true when it
 *  was clicked — and a row that dies while its modal is open says so. */
function findSession(projects, target) {
  if (!target) return null
  const group = (projects ?? []).find(item => item.project === target.project)

  return (group?.sessions ?? []).find(session => session.name === target.name) ?? null
}

// What a step in the timeline is. `blocked` is the only one that raises its
// voice: the agent stopped and is waiting on a person. `done` is muted on
// purpose — a finished turn is the resting state, not an achievement.
const ACTIVITY_TONE = { tool: 'muted', assistant: 'good', dispatch: 'good', blocked: 'warn', done: 'muted' }

/** `…/activity` -> the timeline, and the one line that says what it is doing.
 *
 *  The headline is the whole point of the phase: `working · 3m12s · bash git
 *  rev-list…` instead of `working`. It degrades a piece at a time — no
 *  timestamp drops the age, no transcript drops everything but the verdict —
 *  because a session with nothing on disk to read (a bridged Claude Code peer,
 *  a cwd that moved) is ordinary, and must read as an honest absence rather
 *  than as a broken panel. */
function presentActivity(payload, session = {}) {
  const verdict = stateLabel(session?.state ?? 'unknown')
  const blank = { available: false, headline: verdict, note: '', steps: [], seq: 0 }

  if (!payload || payload.loading) return { ...blank, note: payload?.loading ? 'Reading the transcript…' : '' }

  if (payload.error) {
    const message = String(payload.error)
    // The route is new; a Desktop that has not restarted since it landed 404s
    // on it while the rest of the pane works perfectly. Naming that is more
    // use than the status code.
    return {
      ...blank,
      note: /\b404\b/.test(message) ? 'Restart Hermes Desktop to pick up the activity route' : message.slice(0, 120)
    }
  }

  const seq = typeof payload.seq === 'number' ? payload.seq : 0
  if (payload.available !== true) {
    return { ...blank, seq, note: payload.reason || 'no transcript matches this session' }
  }

  const current = payload.current
  const age = formatAge(current?.since_s)
  const doing = current ? [current.label, current.detail].filter(Boolean).join(' ') : ''

  return {
    available: true,
    // Joined from whatever survived: `working · 3m12s · bash git status`, or
    // just `working` when the transcript has nothing to add.
    headline: [verdict, age, doing].filter(Boolean).join(' · '),
    note: '',
    steps: (payload.steps ?? []).map((step, index) => ({
      // The list is append-only and `seq` is a byte offset, so this is stable
      // across polls even when one line contributed several steps.
      key: `${step.seq}:${index}`,
      kind: step.kind ?? '',
      tone: ACTIVITY_TONE[step.kind] ?? 'muted',
      label: step.label ?? step.kind ?? '',
      detail: step.detail ?? '',
      ariaLabel: [step.label, step.detail].filter(Boolean).join(' ')
    })),
    seq
  }
}

// The monitor's task vocabulary (hermes-monitor-model.ts). `recovering` is the
// one that needed a word rather than a state name: the task is alive and the
// connection to it is not, which is a different worry from either "running" or
// "failed".
const TASK_TONE = {
  starting: 'muted',
  running: 'good',
  cancelling: 'warn',
  recovering: 'warn',
  completed: 'muted',
  blocked: 'warn',
  failed: 'bad',
  cancelled: 'muted',
  orphaned: 'bad'
}

const TASK_LABEL = {
  starting: 'starting',
  running: 'running',
  cancelling: 'cancelling…',
  recovering: 'reconnecting',
  completed: 'done',
  blocked: 'needs answer',
  failed: 'failed',
  cancelled: 'cancelled',
  orphaned: 'orphaned'
}

// Cancellable exactly where the backend says so (tasks.ACTIVE_STATES). Kept as
// its own list rather than "not terminal" so the two ends can be compared by
// reading them, and a button that would always 422 is never offered.
const TASK_ACTIVE = ['starting', 'running', 'cancelling', 'recovering']

/** `…/tasks` -> the subagent tree, flattened for rendering with a depth.
 *
 *  A flat list with `depth` rather than nested arrays: the tree is at most two
 *  levels (a hub turn and its specialists), and a renderer that walks a nested
 *  structure has to recurse for a shape that cannot get deeper. The indentation
 *  is a presentational fact, so it is decided here.
 *
 *  `available: false` is the ordinary answer — the monitor is opt-in and most
 *  hubs run without it — so it returns a sentence, never an alarm. */
function presentTasks(payload) {
  const blank = { available: false, note: '', rows: [], running: 0 }

  if (!payload || payload.loading) return { ...blank, note: payload?.loading ? 'Asking the monitor…' : '' }

  if (payload.error) {
    const message = String(payload.error)
    // Same 404 as the activity route: a Desktop that has not restarted since
    // this landed has no such route, while everything else in the pane works.
    return {
      ...blank,
      note: /\b404\b/.test(message) ? 'Restart Hermes Desktop to pick up the tasks route' : message.slice(0, 120)
    }
  }

  if (payload.available !== true) return { ...blank, note: payload.reason || 'no monitored hub for this session' }

  const rows = []
  let running = 0
  for (const parent of payload.tasks ?? []) {
    for (const [depth, task] of [[0, parent], ...(parent.children ?? []).map(c => [1, c])]) {
      const state = task.state ?? 'orphaned'
      if (TASK_ACTIVE.includes(state)) running += 1
      rows.push({
        key: `${task.hubInstanceId ?? ''}:${task.id}:${task.generation}`,
        depth,
        // The specialist is who it is; the id is only how it is addressed, and
        // a hub turn has no specialist to name.
        label: task.specialist || task.id,
        tone: TASK_TONE[state] ?? 'muted',
        state: TASK_LABEL[state] ?? state,
        // A parent whose own parent was pruned is said out loud — the hierarchy
        // is missing a level and a silently promoted row would misread as a
        // top-level turn.
        note: task.orphaned_parent ? 'parent no longer in the monitor' : '',
        output: task.output ?? '',
        truncated: Boolean(task.truncated),
        canCancel: TASK_ACTIVE.includes(state),
        taskId: task.id,
        generation: task.generation,
        ariaLabel: `${task.specialist || task.id}: ${TASK_LABEL[state] ?? state}`
      })
    }
  }

  return {
    available: true,
    note: rows.length ? '' : 'this hub has not spawned any subagents',
    rows,
    running
  }
}

/** The modal a selected row opens: everything the 300px row had to truncate,
 *  plus what can be done about it.
 *
 *  A list of actions rather than a fixed pair of buttons, because the set is
 *  what changes: sending a prompt used to live here and will again, and an
 *  action that is currently impossible is returned DISABLED with the reason
 *  instead of being hidden — "why can't I focus this one" is the question the
 *  panel exists to answer.
 *
 *  Nothing selected is the resting state, not an error, so it returns a closed
 *  modal rather than a complaint. */
function presentSessionMenu({ target, session, herdrPanes, busy, error, activity, tasks } = {}) {
  if (!target) {
    return {
      open: false,
      title: '',
      state: '',
      note: '',
      description: '',
      facts: [],
      actions: [],
      activity: presentActivity(null),
      tasks: presentTasks(null),
      error: ''
    }
  }

  const state = session?.state ?? 'unknown'
  // A row that vanished from the payload between the click and this render: the
  // selection is re-found every time (`findSession`), so `null` here means the
  // session is gone, and saying so is better than an empty modal.
  const facts = session
    ? [
        ['Purpose', session.purpose],
        ['Model', session.model],
        ['Directory', session.cwd],
        ['Context', typeof session.context_used_pct === 'number' ? `${session.context_used_pct}%` : ''],
        ['Queue', typeof session.queue_depth === 'number' ? String(session.queue_depth) : ''],
        ['Uptime', formatAge(session.uptime_s)],
        // Absent means the entry was written by a coms too old to carry it —
        // not "just now", so it says nothing at all.
        ['Heartbeat', formatAge(session.heartbeat_age_s) ? `${formatAge(session.heartbeat_age_s)} ago` : ''],
        ['Pane', session.pane_id]
      ]
        .filter(([, value]) => Boolean(value))
        .map(([label, value]) => ({ label, value: String(value) }))
    : []

  const note = session ? sessionNote(session, herdrPanes) : 'this session is no longer in the registry'
  const timeline = presentActivity(session ? activity : null, session ?? {})
  const subagents = presentTasks(session ? tasks : null)
  const verdict = session ? stateLabel(state) : 'gone'

  return {
    open: true,
    title: `${target.name} · ${target.project}`,
    state: verdict,
    note,
    // The one line under the title. The transcript wins when it has something
    // to say — `working · 3m12s · bash git status` answers "what is it doing",
    // which `working — ` never could — and the registry's verdict is the
    // fallback, not a second line saying the same word twice.
    //
    // A running subagent count joins it because a hub whose own transcript is
    // idle while three specialists work is the case the panel used to read as
    // "nothing is happening".
    description: [
      timeline.available ? timeline.headline : note ? `${verdict} — ${note}` : verdict,
      subagents.running ? plural(subagents.running, 'subagent') : ''
    ]
      .filter(Boolean)
      .join(' · '),
    facts,
    activity: timeline,
    // The subagents this hub spawned, live, with a Cancel on each. The only
    // part of the modal that can STOP something rather than describe it.
    tasks: subagents,
    actions: [
      {
        id: 'focus',
        label: 'Focus pane',
        // Possible only while herdr reports a pane for this peer. A `detached`
        // row is a live session — coms still reaches its own socket — there is
        // simply nothing to bring to the front.
        enabled: Boolean(session?.workspace_id) && !busy,
        detail: session?.workspace_id
          ? 'Bring the herdr pane running it to the front'
          : 'No herdr pane is hosting this agent right now'
      }
    ],
    error: error ?? ''
  }
}

/** One row, already decided: colour is never the only carrier of "waiting".
 *
 *  `herdrPanes` comes from the payload, not from the row, which is why this
 *  takes a second argument instead of reading a global. */
function presentSession(session, { herdrPanes } = {}) {
  const state = session.state ?? 'unknown'
  const note = sessionNote(session, herdrPanes)
  const uptime = formatAge(session.uptime_s)
  const meta = [session.model, session.repo]

  // Context and queue are what the herdr sidebar shows for the same peer;
  // keeping the vocabulary identical means one glance works in both places.
  if (typeof session.context_used_pct === 'number') meta.push(`ctx ${session.context_used_pct}%`)
  // A queue of zero is the resting state and says nothing worth 4 characters
  // in a 300px pane. A queue that is NOT zero is the reason a peer looks idle
  // while work is waiting.
  if (session.queue_depth) meta.push(`q${session.queue_depth}`)
  if (uptime) meta.push(`up ${uptime}`)

  return {
    name: session.name,
    tone: stateTone(state),
    label: stateLabel(state),
    // A glyph, not a hue — a red dot is invisible to a third of the reasons
    // people open an accessibility guideline.
    marker: session.needs_answer ? '▲' : '·',
    meta: meta.filter(Boolean).join(' · '),
    note,
    ariaLabel: `${session.name}: ${stateLabel(state)}${session.needs_answer ? ', waiting for an answer' : ''}${note ? `, ${note}` : ''}`
  }
}

// What a fleet transition is worth interrupting for. `error` and `warning` are
// sticky in the app's notification stack (notifications.ts:defaultDuration),
// which is the correct behaviour for "somebody is waiting on you" and the wrong
// one for "a session ended".
const EVENT_KIND = {
  needs_answer: 'warning',
  stale: 'warning',
  dispatch_failed: 'warning',
  vanished: 'error',
  unblocked: 'info',
  finished: 'info',
  dispatch_answered: 'info',
  throttled: 'info'
}

const EVENT_TITLE = {
  needs_answer: 'Waiting for you',
  stale: 'Heartbeat stopped',
  dispatch_failed: 'Prompt failed',
  vanished: 'Agent vanished',
  unblocked: 'No longer waiting',
  finished: 'Session ended',
  dispatch_answered: 'Answer received',
  throttled: 'Too much at once'
}

/** `/events` -> the toasts to raise and the cursor to resume from.
 *
 *  `primed` is false for the very first answer, whose events are whatever
 *  survived in the buffer from before this pane existed. Their cursor is taken
 *  and their toasts are dropped: a pane opening is not the moment to be told
 *  about a question that was answered an hour ago, and the list below is where
 *  the current state lives anyway.
 *
 *  `after` is what the caller has already shown. Two feeds deliver the same
 *  numbered events — the poll and the socket — and either may repeat what the
 *  other just delivered, so the cursor is applied HERE rather than trusted to
 *  the request: an event at or behind it is one this pane has already raised.
 *  For the same reason the returned cursor never goes backwards, so a frame
 *  that overtakes another cannot un-see events.
 *
 *  The toast id is `(kind, project, name)`, which the app treats as a replace —
 *  so an agent that flaps updates one toast instead of stacking a column of
 *  them. */
function presentEvents(payload, primed = true, after = 0) {
  const reported = typeof payload?.seq === 'number' ? payload.seq : 0
  const cursor = typeof after === 'number' && after > 0 ? after : 0
  const events = (primed ? payload?.events ?? [] : []).filter(
    event => typeof event?.seq !== 'number' || event.seq > cursor
  )

  return {
    seq: Math.max(reported, cursor),
    toasts: events.map(event => ({
      id: `agent-fleet:${event.kind}:${event.project ?? ''}:${event.name ?? ''}`,
      kind: EVENT_KIND[event.kind] ?? 'info',
      title: EVENT_TITLE[event.kind] ?? 'Agent Fleet',
      message: event.message ?? event.kind
    }))
  }
}

// A socket frame this recent means the push transport is delivering. Longer
// than the server's 20s keepalive so one late frame does not read as a dead
// connection — `ctx.socket` gives the caller no close event, so "when did it
// last speak" is the only liveness signal there is.
const SOCKET_FRESH_MS = 25000

// How often to poll anyway while the socket is delivering. Not zero, ever: the
// stream drops a batch rather than queue it without bound, and this is what
// picks that batch up. It is the difference between a fallback and a hope.
const SOCKET_POLL_MS = 30000

/** Whether a tick of the events poll should actually fetch.
 *
 *  The socket does not replace the poll, it slows it down: with frames
 *  arriving, the poll drops from every 5s to every 30s and becomes a safety
 *  net; the moment frames stop — a dropped connection, an OAuth remote where
 *  `ctx.socket` is a documented no-op — the next tick fetches again. Nothing
 *  has to detect the failure, because nothing was ever switched off. */
function shouldPollEvents({ lastFrameAt = 0, lastPollAt = 0, now = 0 } = {}) {
  if (!lastFrameAt || now - lastFrameAt > SOCKET_FRESH_MS) return true

  return !lastPollAt || now - lastPollAt >= SOCKET_POLL_MS
}

/** 3s polling with the two guards the monitor pane learned to need
 *  (`state.js:createActiveViewController`): no overlapping requests, and an
 *  epoch that voids answers arriving after the pane went away. Timer functions
 *  are injectable so the whole thing is testable without a DOM.
 *
 *  Both feeds run on this — `/sessions` for the list and `/events` for the
 *  toasts — because the guards are the same problem in both cases.
 *
 *  `shouldPoll` is the third guard, and only the events feed uses it: a tick
 *  that answers false is skipped, not cancelled, so the cadence can change
 *  without the timer being torn down and rebuilt. */
function createSessionsPoller({
  fetchSessions,
  onValue,
  intervalMs = 3000,
  shouldPoll = null,
  setTimer = setInterval,
  clearTimer = clearInterval
}) {
  let timer = null
  let visible = false
  let inFlight = null
  let epoch = 0

  const poll = () => {
    if (!visible || inFlight) return inFlight
    if (shouldPoll && !shouldPoll()) return null
    const requestEpoch = epoch
    const request = (async () => {
      try {
        const payload = await fetchSessions()
        if (visible && requestEpoch === epoch) onValue(payload)
      } catch (error) {
        if (visible && requestEpoch === epoch) onValue({ error: error?.message ?? String(error) })
      }
    })().finally(() => {
      if (inFlight === request) inFlight = null
    })

    inFlight = request

    return request
  }

  return {
    poll,
    setVisible(next) {
      if (!next) {
        visible = false
        epoch++
        if (timer) clearTimer(timer)
        timer = null

        return
      }
      visible = true
      if (!timer) timer = setTimer(() => void poll(), intervalMs)
    },
    dispose() {
      visible = false
      epoch++
      if (timer) clearTimer(timer)
      timer = null
    }
  }
}

// <<< END SHARED >>>

export {
  countSessions,
  countWaiting,
  createSessionsPoller,
  findSession,
  formatAge,
  presentActivity,
  presentDispatch,
  presentEvents,
  presentSession,
  presentSessionMenu,
  presentSessions,
  presentTasks,
  sessionNote,
  shouldPollEvents,
  stateLabel,
  stateTone
}
