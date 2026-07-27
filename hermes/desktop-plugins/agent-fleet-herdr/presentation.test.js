import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
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
} from './presentation.js'

const here = fileURLToPath(new URL('.', import.meta.url))

const sample = ({ herdr = true, projects = [] } = {}) => ({ herdr, projects, collected_at: '2026-07-26T21:00:00Z' })
const session = (name, state, extra = {}) => ({
  name,
  state,
  needs_answer: state === 'blocked',
  model: 'minimax-m3:cloud',
  repo: 'agent-fleet',
  ...extra
})

test('plugin.js carries a byte-identical copy of the shared block', () => {
  // The Desktop loader evaluates plugin.js as a blob, where a relative import
  // cannot resolve — so the pure logic is duplicated by necessity. This test is
  // what keeps the duplicate honest.
  const extract = file => {
    const source = readFileSync(here + file, 'utf-8')
    const start = source.indexOf('// <<< SHARED WITH plugin.js — keep byte-identical >>>')
    const end = source.indexOf('// <<< END SHARED >>>')
    assert.ok(start >= 0 && end > start, `${file} is missing the shared markers`)

    return source.slice(start, end)
  }

  assert.equal(extract('plugin.js'), extract('presentation.js'))
})

test('state tones separate working, idle and waiting', () => {
  assert.equal(stateTone('working'), 'good')
  assert.equal(stateTone('idle'), 'muted')
  assert.equal(stateTone('blocked'), 'warn')
  assert.equal(stateTone('detached'), 'bad')
  assert.equal(stateTone('unknown'), 'bad')
  assert.equal(stateTone('something-new'), 'bad')
})

test('a waiting agent is labelled in words, not only in colour', () => {
  const row = presentSession(session('reviewer', 'blocked'))
  assert.equal(row.label, 'needs answer')
  assert.equal(row.marker, '▲')
  assert.match(row.ariaLabel, /waiting for an answer/)

  const calm = presentSession(session('orchestrator', 'working'))
  assert.equal(calm.marker, '·')
  assert.doesNotMatch(calm.ariaLabel, /waiting/)
})

test('a row shows model and repo, and survives missing fields', () => {
  assert.equal(presentSession(session('a', 'idle')).meta, 'minimax-m3:cloud · agent-fleet')
  assert.equal(presentSession({ name: 'a' }).label, 'unknown')
  assert.equal(presentSession({ name: 'a', model: 'claude-code' }).meta, 'claude-code')
})

test('counts cover every project', () => {
  const projects = [
    { project: 'alpha', sessions: [session('a', 'working'), session('b', 'blocked')] },
    { project: 'beta', sessions: [session('c', 'idle')] }
  ]
  assert.equal(countSessions(projects), 3)
  assert.equal(countWaiting(projects), 1)
  assert.equal(stateLabel('detached'), 'detached')
})

test('waiting agents own the headline', () => {
  const view = presentSessions(
    sample({ projects: [{ project: 'alpha', sessions: [session('a', 'working'), session('b', 'blocked')] }] })
  )
  assert.equal(view.kind, 'projects')
  assert.equal(view.tone, 'warn')
  assert.equal(view.headline, '1 agent waiting for you')
})

test('a calm fleet reports its size', () => {
  const view = presentSessions(
    sample({
      projects: [
        { project: 'alpha', sessions: [session('a', 'working'), session('b', 'idle')] },
        { project: 'beta', sessions: [session('c', 'idle')] }
      ]
    })
  )
  assert.equal(view.tone, 'good')
  assert.equal(view.headline, '3 sessions in 2 projects')
  assert.equal(view.detail, '')
})

test('"herdr is down" and "nobody is running" are different sentences', () => {
  // The probe's lesson: a state a human has to parse out of a payload is a
  // state they will misread.
  const noSessions = presentSessions(sample({ projects: [] }))
  const alsoNoHerdr = presentSessions(sample({ herdr: false, projects: [] }))
  assert.equal(noSessions.kind, 'empty')
  assert.equal(alsoNoHerdr.kind, 'empty')
  assert.notEqual(noSessions.detail, alsoNoHerdr.detail)

  const degraded = presentSessions(sample({ herdr: false, projects: [{ project: 'alpha', sessions: [session('a', 'unknown')] }] }))
  assert.equal(degraded.kind, 'projects', 'sessions must still render when herdr is down')
  assert.match(degraded.detail, /herdr not answering/)
})

test('a 404 reads as a configuration answer, not a crash', () => {
  const view = presentSessions({ error: "Error invoking remote method 'hermes:api': Error: 404: Plugin not found" })
  assert.equal(view.kind, 'unavailable')
  assert.equal(view.tone, 'muted')
  assert.equal(view.headline, 'Fleet backend not enabled')
  assert.match(view.detail, /hermes plugins enable agent-fleet-herdr/)
  assert.deepEqual(view.projects, [])
})

test('other failures show their own message, bounded', () => {
  const view = presentSessions({ error: `503: ${'x'.repeat(500)}` })
  assert.equal(view.headline, 'Fleet backend unavailable')
  assert.ok(view.detail.length <= 200)
})

test('loading is its own state', () => {
  assert.equal(presentSessions({ loading: true }).kind, 'loading')
})

test('the poller does nothing until the pane is visible', async () => {
  let calls = 0
  const poller = createSessionsPoller({
    fetchSessions: async () => {
      calls++

      return sample()
    },
    onValue: () => {},
    setTimer: () => 1,
    clearTimer: () => {}
  })

  await poller.poll()
  assert.equal(calls, 0)
  poller.setVisible(true)
  await poller.poll()
  assert.equal(calls, 1)
})

test('the poller never overlaps two requests', async () => {
  let started = 0
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const poller = createSessionsPoller({
    fetchSessions: async () => {
      started++
      await gate

      return sample()
    },
    onValue: () => {},
    setTimer: () => 1,
    clearTimer: () => {}
  })
  poller.setVisible(true)

  const first = poller.poll()
  poller.poll()
  assert.equal(started, 1)
  release()
  await first
  await poller.poll()
  assert.equal(started, 2)
})

test('an answer that arrives after the pane is hidden is discarded', async () => {
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const seen = []
  const poller = createSessionsPoller({
    fetchSessions: async () => {
      await gate

      return sample({ projects: [{ project: 'alpha', sessions: [session('a', 'working')] }] })
    },
    onValue: value => seen.push(value),
    setTimer: () => 1,
    clearTimer: () => {}
  })

  poller.setVisible(true)
  const inFlight = poller.poll()
  poller.setVisible(false)
  release()
  await inFlight
  assert.deepEqual(seen, [])
})

test('a failed poll surfaces as an error value, not a rejection', async () => {
  const seen = []
  const poller = createSessionsPoller({
    fetchSessions: async () => {
      throw new Error('404: Plugin not found')
    },
    onValue: value => seen.push(value),
    setTimer: () => 1,
    clearTimer: () => {}
  })

  poller.setVisible(true)
  await poller.poll()
  assert.equal(presentSessions(seen[0]).headline, 'Fleet backend not enabled')
})

test('hiding the pane stops the timer, showing it starts one', () => {
  const cleared = []
  let timers = 0
  const poller = createSessionsPoller({
    fetchSessions: async () => sample(),
    onValue: () => {},
    setTimer: () => ++timers,
    clearTimer: id => cleared.push(id)
  })

  poller.setVisible(true)
  poller.setVisible(true)
  assert.equal(timers, 1, 'a second show must not start a second timer')
  poller.setVisible(false)
  assert.deepEqual(cleared, [1])
  poller.setVisible(true)
  assert.equal(timers, 2)
  poller.dispose()
  assert.deepEqual(cleared, [1, 2])
})

test('a dispatch says which of the three silences it hit', () => {
  const sent = { msg_id: 'M1', project: 'af', name: 'orchestrator', prompt: 'count the files' }

  assert.equal(presentDispatch({ ...sent, status: 'pending' }).label, 'working on it')
  assert.equal(presentDispatch({ ...sent, status: 'pending' }).tone, 'muted')
  // never reached the peer / reached it and was refused / never answered
  assert.equal(presentDispatch({ ...sent, status: 'failed' }).label, 'not delivered')
  assert.equal(presentDispatch({ ...sent, status: 'error' }).label, 'refused')
  assert.equal(presentDispatch({ ...sent, status: 'timeout' }).label, 'no answer')
  assert.equal(presentDispatch({ ...sent, status: 'timeout' }).tone, 'warn')

  const answered = presentDispatch({ ...sent, status: 'answered', response: '1408 files' })
  assert.equal(answered.tone, 'good')
  assert.equal(answered.body, '1408 files')
  assert.equal(answered.target, 'orchestrator · af')
})

test('a failed dispatch shows the reason where the answer would have been', () => {
  const row = presentDispatch({
    msg_id: 'M2', project: 'af', name: 'ghost', prompt: 'go',
    status: 'failed', detail: 'peer is not listening'
  })
  assert.equal(row.body, 'peer is not listening')
})

test('an unknown dispatch status is shown, not swallowed', () => {
  const row = presentDispatch({ msg_id: 'M3', project: 'af', name: 'x', prompt: 'p', status: 'weird' })
  assert.equal(row.label, 'weird')
  assert.equal(row.tone, 'bad')
})

test('nothing selected is a closed modal, not a complaint', () => {
  const idle = presentSessionMenu({})
  assert.equal(idle.open, false)
  assert.deepEqual(idle.actions, [])
  assert.deepEqual(idle.facts, [])
  assert.equal(idle.error, '')
})

test('the modal shows what the row had to truncate, and nothing it does not know', () => {
  const menu = presentSessionMenu({
    target: { project: 'af', name: 'orchestrator' },
    session: session('orchestrator', 'working', {
      purpose: 'Verification-Contract orchestrator',
      cwd: '/home/nchankov/repos/agent-fleet',
      context_used_pct: 12,
      queue_depth: 0,
      uptime_s: 840,
      heartbeat_age_s: 4,
      pane_id: 'wA:p13'
    })
  })

  assert.equal(menu.open, true)
  assert.equal(menu.title, 'orchestrator · af')
  assert.equal(menu.state, 'working')
  assert.equal(menu.note, '', 'a healthy row needs no sentence here either')
  const facts = Object.fromEntries(menu.facts.map(fact => [fact.label, fact.value]))
  assert.equal(facts.Purpose, 'Verification-Contract orchestrator')
  assert.equal(facts.Directory, '/home/nchankov/repos/agent-fleet')
  assert.equal(facts.Context, '12%')
  // Labelled, so unlike the row there is no ambiguity in showing zero.
  assert.equal(facts.Queue, '0')
  assert.equal(facts.Uptime, '14m00s')
  assert.equal(facts.Heartbeat, '4s ago')
  assert.equal(facts.Pane, 'wA:p13')

  // A field the registry never carried must not become a fact at all — an
  // "Uptime: " with nothing after it is a claim that we looked and found zero.
  const sparse = presentSessionMenu({ target: { project: 'af', name: 'x' }, session: { name: 'x', state: 'idle' } })
  assert.deepEqual(sparse.facts, [])
})

test('focus stays visible when it is impossible, and says why', () => {
  const target = { project: 'af', name: 'orchestrator' }
  const hosted = presentSessionMenu({ target, session: session('orchestrator', 'working', { workspace_id: 'wA' }) })
  const [focus] = hosted.actions
  assert.equal(focus.id, 'focus')
  assert.equal(focus.label, 'Focus pane')
  assert.equal(focus.enabled, true)

  // Detached is a LIVE session that no pane hosts — the action is impossible,
  // which is a different statement from the agent being unreachable.
  const detached = presentSessionMenu({ target, session: session('orchestrator', 'detached') })
  assert.equal(detached.actions.length, 1, 'an impossible action is disabled, never hidden')
  assert.equal(detached.actions[0].enabled, false)
  assert.match(detached.actions[0].detail, /No herdr pane/)
  assert.match(detached.note, /alive/)

  // An action in flight must not be startable twice.
  const working = presentSessionMenu({ target, session: session('orchestrator', 'idle', { workspace_id: 'wA' }), busy: true })
  assert.equal(working.actions[0].enabled, false)
})

test('a failed action keeps the modal open with the reason on it', () => {
  const menu = presentSessionMenu({
    target: { project: 'af', name: 'orchestrator' },
    session: session('orchestrator', 'idle', { workspace_id: 'wA' }),
    error: 'orchestrator is not in a herdr pane'
  })
  assert.equal(menu.open, true)
  assert.equal(menu.error, 'orchestrator is not in a herdr pane')
  assert.equal(menu.actions[0].enabled, true, 'a rejected action must leave you able to try again')
})

test('a session that dies while its modal is open says so', () => {
  // `findSession` returns null once the row leaves the payload. An empty modal
  // would read as a rendering failure.
  const menu = presentSessionMenu({ target: { project: 'af', name: 'ghost' }, session: null })
  assert.equal(menu.open, true)
  assert.equal(menu.state, 'gone')
  assert.match(menu.note, /no longer in the registry/)
  assert.equal(menu.actions[0].enabled, false)
})

test('dispatches ride along with the sessions payload', () => {
  const view = presentSessions({
    ...sample({ projects: [{ project: 'af', sessions: [session('orchestrator', 'idle')] }] }),
    dispatches: [{ msg_id: 'M1', project: 'af', name: 'orchestrator', prompt: 'p', status: 'pending' }]
  })
  assert.equal(view.dispatches.length, 1)
  // absent is an empty list, never undefined — the renderer maps over it
  assert.deepEqual(presentSessions(sample()).dispatches, [])
})

test('every view kind carries the lists the renderer maps over', () => {
  // The pane does `view.projects.map(...)` and `view.dispatches.length`
  // unconditionally, so a branch that omits either does not degrade — it throws
  // "Cannot read properties of undefined" and the whole pane fails to render.
  // `loading` is the first thing the pane ever sees, so it is the one that
  // matters most.
  const inputs = {
    loading: { loading: true },
    unavailable: { error: 'boom' },
    empty: sample(),
    projects: sample({ projects: [{ project: 'af', sessions: [session('orchestrator', 'idle')] }] })
  }

  for (const [kind, input] of Object.entries(inputs)) {
    const view = presentSessions(input)
    assert.equal(view.kind, kind)
    assert.ok(Array.isArray(view.projects), `${kind}: projects must be an array`)
    assert.ok(Array.isArray(view.dispatches), `${kind}: dispatches must be an array`)
    assert.equal(typeof view.headline, 'string', `${kind}: headline must be a string`)
    assert.equal(typeof view.detail, 'string', `${kind}: detail must be a string`)
    assert.equal(typeof view.tone, 'string', `${kind}: tone must be a string`)
  }
})

test('a dispatch survives a poll that has not answered yet', () => {
  // Sending refreshes; the refresh briefly has no payload. The Sent list must
  // not take the pane down while it is in flight.
  const view = presentSessions({ loading: true, dispatches: [{ msg_id: 'M1', name: 'o', project: 'af', prompt: 'p' }] })
  assert.equal(view.dispatches.length, 1)
})

test('ages read at a glance, and an unknown age says nothing at all', () => {
  assert.equal(formatAge(0), '0s')
  assert.equal(formatAge(45), '45s')
  // Seconds survive below the hour: that is the range a turn is watched in.
  assert.equal(formatAge(192), '3m12s')
  assert.equal(formatAge(65), '1m05s')
  assert.equal(formatAge(8000), '2h13m')
  assert.equal(formatAge(300000), '3d11h')
  // The backend sends null for a timestamp it could not read. "0s" would be a
  // claim about a session; the empty string is the absence of one.
  assert.equal(formatAge(null), '')
  assert.equal(formatAge(undefined), '')
  assert.equal(formatAge(-5), '')
  assert.equal(formatAge(Number.NaN), '')
})

test('a row carries context, a non-empty queue and uptime', () => {
  const row = presentSession(session('a', 'working', { context_used_pct: 12, queue_depth: 0, uptime_s: 840 }))
  assert.equal(row.meta, 'minimax-m3:cloud · agent-fleet · ctx 12% · up 14m00s')

  const busy = presentSession(session('a', 'working', { context_used_pct: 0, queue_depth: 3, uptime_s: 5 }))
  assert.match(busy.meta, /ctx 0% · q3 · up 5s/, 'a queue that is not empty is why an idle-looking peer is not idle')
})

test('detached is explained by how much herdr could see', () => {
  const row = session('a', 'detached')
  assert.equal(sessionNote(row, 0), 'alive — herdr reports no panes at all')
  assert.equal(sessionNote(row, 1), 'alive — none of 1 herdr pane reports it')
  assert.equal(sessionNote(row, 7), 'alive — none of 7 herdr panes reports it')
  // A payload from before the count existed must not invent one.
  assert.equal(sessionNote(row, undefined), 'alive, but no herdr pane reports it')
})

test('a stopped heartbeat outranks the view-level explanation', () => {
  // The process may be wedged. That is a bigger statement than "no pane shows
  // it", and it must not be hidden behind one.
  const row = session('a', 'detached', { stale: true, heartbeat_age_s: 240 })
  assert.equal(sessionNote(row, 3), 'no heartbeat for 4m00s')
  assert.equal(presentSession(row, { herdrPanes: 3 }).note, 'no heartbeat for 4m00s')
  assert.match(presentSession(row, { herdrPanes: 3 }).ariaLabel, /no heartbeat/)
})

test('an unknown row blames herdr rather than the fleet', () => {
  assert.equal(sessionNote(session('a', 'unknown')), 'herdr did not answer — state unknown')
  assert.equal(sessionNote(session('a', 'working')), '', 'a healthy row needs no sentence')
})

test('the pane forwards the pane count from the payload, not from a row', () => {
  const view = presentSessions({ ...sample({ projects: [{ project: 'alpha', sessions: [session('a', 'detached')] }] }), herdr_panes: 4 })
  assert.equal(view.herdrPanes, 4)
})

test('a pending dispatch ages against now; a finished one keeps what it took', () => {
  const now = Date.parse('2026-07-26T21:03:12.000Z')
  const pending = presentDispatch({ msg_id: 'M1', name: 'reviewer', project: 'alpha', prompt: 'count', sent_at: '2026-07-26T21:00:00.000Z' }, now)
  assert.equal(pending.label, 'working on it')
  assert.equal(pending.age, '3m12s')
  assert.match(pending.ariaLabel, /working on it after 3m12s/)

  const answered = presentDispatch(
    { msg_id: 'M2', name: 'reviewer', project: 'alpha', prompt: 'count', status: 'answered', sent_at: '2026-07-26T21:00:00.000Z', answered_at: '2026-07-26T21:02:00.000Z' },
    now
  )
  assert.equal(answered.age, '2m00s', 'an answered dispatch must stop counting when the answer landed')
})

test('a dispatch with no timestamps still renders', () => {
  const row = presentDispatch({ msg_id: 'M3', name: 'reviewer', project: 'alpha', prompt: 'count' }, Date.now())
  assert.equal(row.age, '')
  assert.equal(row.label, 'working on it')
})

test('the first answer sets the cursor and raises nothing', () => {
  // The buffer can hold events from before this pane was mounted. Replaying
  // them as toasts would announce an hour-old question as if it were live.
  const payload = {
    seq: 12,
    events: [{ seq: 12, kind: 'needs_answer', project: 'af', name: 'reviewer', message: 'reviewer · af needs an answer' }]
  }
  const first = presentEvents(payload, false)
  assert.equal(first.seq, 12)
  assert.deepEqual(first.toasts, [])

  assert.equal(presentEvents(payload, true).toasts.length, 1)
})

test('what interrupts you and what merely informs you are different kinds', () => {
  const of = kind => presentEvents({ seq: 1, events: [{ kind, project: 'af', name: 'a', message: 'm' }] }).toasts[0]

  // Sticky in the app's stack — the two that mean "this is not finished".
  assert.equal(of('needs_answer').kind, 'warning')
  assert.equal(of('stale').kind, 'warning')
  assert.equal(of('vanished').kind, 'error')
  // Ambient — something that is already over.
  assert.equal(of('finished').kind, 'info')
  assert.equal(of('unblocked').kind, 'info')
  assert.equal(of('needs_answer').title, 'Waiting for you')

  // A kind this renderer has never heard of is shown, not swallowed: the
  // backend can grow a vocabulary without the pane being updated first.
  const unknown = of('something_new')
  assert.equal(unknown.kind, 'info')
  assert.equal(unknown.message, 'm')
})

test('one agent flapping replaces its toast instead of stacking a column', () => {
  const [first] = presentEvents({ seq: 1, events: [{ kind: 'needs_answer', project: 'af', name: 'a', message: 'm' }] }).toasts
  const [again] = presentEvents({ seq: 2, events: [{ kind: 'needs_answer', project: 'af', name: 'a', message: 'm' }] }).toasts
  const [other] = presentEvents({ seq: 3, events: [{ kind: 'needs_answer', project: 'af', name: 'b', message: 'm' }] }).toasts

  assert.equal(first.id, again.id, 'the app replaces a notification with a matching id')
  assert.notEqual(first.id, other.id, 'two agents are two notifications')
})

test('an empty poll still moves the cursor', () => {
  // Otherwise a pane that fell behind the ring buffer replays a truncated past
  // as if it were the present, forever.
  assert.deepEqual(presentEvents({ seq: 40, events: [] }), { seq: 40, toasts: [] })
  assert.deepEqual(presentEvents(undefined), { seq: 0, toasts: [] })
})

test('an event the other feed already delivered raises no second toast', () => {
  // The socket and the poll carry the same numbered events, and both may
  // deliver the same one — the socket pushes it, the poll was already in
  // flight. The cursor is what makes them interchangeable instead of additive.
  const payload = {
    seq: 9,
    events: [
      { seq: 8, kind: 'needs_answer', project: 'af', name: 'reviewer', message: 'old news' },
      { seq: 9, kind: 'vanished', project: 'af', name: 'builder', message: 'fresh news' }
    ]
  }
  const view = presentEvents(payload, true, 8)
  assert.deepEqual(view.toasts.map(t => t.message), ['fresh news'])
  assert.equal(view.seq, 9)
})

test('a frame that arrives out of order cannot rewind the cursor', () => {
  // Two feeds, no ordering guarantee between them. A cursor that went backwards
  // would re-raise everything between the two numbers.
  assert.equal(presentEvents({ seq: 3, events: [] }, true, 11).seq, 11)
})

test('an event without a sequence number is still shown', () => {
  // The cursor is a filter, not a requirement: a backend that ever sends an
  // unnumbered event should interrupt, not be silently dropped.
  const view = presentEvents({ seq: 5, events: [{ kind: 'stale', project: 'af', name: 'a', message: 'm' }] }, true, 4)
  assert.equal(view.toasts.length, 1)
})

test('the events poll steps down while the socket delivers and back up when it stops', () => {
  const now = 1_000_000

  // No frame ever seen — an OAuth remote, an older host, a refused upgrade.
  assert.equal(shouldPollEvents({ lastFrameAt: 0, lastPollAt: now - 1000, now }), true)

  // Frames arriving: the poll becomes a 30s safety net for what the stream
  // dropped, not the feed.
  assert.equal(shouldPollEvents({ lastFrameAt: now - 2000, lastPollAt: now - 5000, now }), false)
  assert.equal(shouldPollEvents({ lastFrameAt: now - 2000, lastPollAt: now - 31_000, now }), true)

  // The socket went quiet past the server's keepalive. Nothing had to detect
  // the failure — the next tick simply polls again.
  assert.equal(shouldPollEvents({ lastFrameAt: now - 26_000, lastPollAt: now - 1000, now }), true)

  // Called with nothing at all, on the very first tick: poll.
  assert.equal(shouldPollEvents(), true)
})

test('a poller tick that should be skipped costs no request', async () => {
  let calls = 0
  let allow = false
  const poller = createSessionsPoller({
    fetchSessions: async () => {
      calls++

      return sample()
    },
    onValue: () => {},
    shouldPoll: () => allow,
    setTimer: () => 1,
    clearTimer: () => {}
  })

  poller.setVisible(true)
  await poller.poll()
  assert.equal(calls, 0, 'the gate said no')
  allow = true
  await poller.poll()
  assert.equal(calls, 1, 'and the same timer resumes the moment it says yes')
})

test('a selection is re-found in the current payload, never remembered', () => {
  const projects = [
    { project: 'alpha', sessions: [session('orchestrator', 'working', { workspace_id: 'wA' })] },
    { project: 'zulu', sessions: [session('orchestrator', 'idle')] }
  ]
  // Two projects, one name: the pair is the key here exactly as it is in the
  // backend join.
  assert.equal(findSession(projects, { project: 'zulu', name: 'orchestrator' }).state, 'idle')
  assert.equal(findSession(projects, { project: 'alpha', name: 'gone' }), null)
  assert.equal(findSession(projects, null), null)
  assert.equal(findSession(undefined, { project: 'alpha', name: 'orchestrator' }), null)
})

const activityPayload = (steps, current, extra = {}) => ({
  available: true,
  reason: '',
  steps,
  current,
  seq: steps.length ? steps[steps.length - 1].seq : 0,
  ...extra
})
const step = (kind, label, detail = '', seq = 100) => ({ seq, at: '2026-07-27T09:00:00Z', kind, label, detail })

test('the activity headline answers what it is doing, not merely that it is', () => {
  // The whole point of the phase: `working` was true and useless.
  const view = presentActivity(
    activityPayload([step('tool', 'bash', 'git rev-list --count HEAD')], {
      kind: 'tool',
      label: 'bash',
      detail: 'git rev-list --count HEAD',
      since_s: 192
    }),
    { state: 'working' }
  )

  assert.equal(view.available, true)
  assert.equal(view.headline, 'working · 3m12s · bash git rev-list --count HEAD')
})

test('the headline degrades one piece at a time rather than all at once', () => {
  // An unreadable timestamp drops the age and keeps the action.
  const noAge = presentActivity(activityPayload([], { kind: 'tool', label: 'read', detail: '/etc/hosts', since_s: null }), {
    state: 'working'
  })
  assert.equal(noAge.headline, 'working · read /etc/hosts')

  // No current step at all leaves the verdict standing on its own.
  const noStep = presentActivity(activityPayload([], null), { state: 'idle' })
  assert.equal(noStep.headline, 'idle')
})

test('no transcript is a sentence, never a blank space or an error', () => {
  const view = presentActivity(
    { available: false, reason: 'no pi transcript matches this session', steps: [], current: null, seq: 0 },
    { state: 'detached' }
  )

  assert.equal(view.available, false)
  assert.equal(view.headline, 'detached', 'the verdict still stands without a transcript')
  assert.match(view.note, /no pi transcript/)
  assert.deepEqual(view.steps, [])
})

test('a 404 on the activity route names the restart rather than the status code', () => {
  // The route is new. A Desktop that has not restarted since it landed 404s on
  // this one endpoint while the rest of the pane works perfectly.
  const missing = presentActivity({ error: 'GET /activity failed: 404' }, { state: 'working' })
  assert.match(missing.note, /Restart Hermes Desktop/)

  const broken = presentActivity({ error: 'connection reset' }, { state: 'working' })
  assert.equal(broken.note, 'connection reset')
  assert.equal(broken.available, false)
})

test('a step that stops for a human is the only one that raises its voice', () => {
  const tones = Object.fromEntries(
    ['tool', 'assistant', 'dispatch', 'blocked', 'done'].map(kind => [
      kind,
      presentActivity(activityPayload([step(kind, 'x')]), {}).steps[0].tone
    ])
  )

  assert.equal(tones.blocked, 'warn')
  assert.equal(tones.dispatch, 'good')
  assert.equal(tones.tool, 'muted')
  // A finished turn is the resting state, not an achievement.
  assert.equal(tones.done, 'muted')
  // A kind the backend grew after this file was written is shown, not dropped.
  assert.equal(presentActivity(activityPayload([step('something_new', 'x')]), {}).steps[0].tone, 'muted')
})

test('two steps from one transcript line keep distinct keys', () => {
  // An assistant turn with three tool calls shares one byte offset, and React
  // needs them to be three list items rather than one.
  const view = presentActivity(activityPayload([step('tool', 'read', '/1', 88), step('tool', 'read', '/2', 88)]), {})
  assert.equal(new Set(view.steps.map(s => s.key)).size, 2)
})

test('the modal prefers the transcript over the verdict for its one line', () => {
  const target = { project: 'af', name: 'orchestrator' }
  const live = presentSessionMenu({
    target,
    session: session('orchestrator', 'working', { workspace_id: 'wA' }),
    activity: activityPayload([step('tool', 'bash', 'npm test')], { kind: 'tool', label: 'bash', detail: 'npm test', since_s: 45 })
  })
  assert.equal(live.description, 'working · 45s · bash npm test')
  assert.equal(live.activity.steps.length, 1)

  // Without a transcript the modal reads exactly as it did before this phase.
  const blind = presentSessionMenu({ target, session: session('orchestrator', 'detached') })
  assert.match(blind.description, /^detached — alive/)
  assert.equal(blind.activity.available, false)
})

test('a session that died keeps its own verdict rather than borrowing a transcript', () => {
  // `findSession` returns null once the row leaves the payload; an activity
  // payload left over from the last poll must not make a gone agent look busy.
  const menu = presentSessionMenu({
    target: { project: 'af', name: 'ghost' },
    session: null,
    activity: activityPayload([step('tool', 'bash', 'sleep 60')], { kind: 'tool', label: 'bash', since_s: 3 })
  })

  assert.equal(menu.state, 'gone')
  assert.match(menu.description, /^gone — /)
  assert.deepEqual(menu.activity.steps, [])
})

// --- Phase 4: the monitor's subagent tree, inside the same modal ------------

const taskPayload = (tasks = []) => ({ available: true, reason: '', tasks })
const parentTask = (children = [], extra = {}) => ({
  id: 'turn-1',
  generation: 1,
  kind: 'parent',
  state: 'running',
  hubInstanceId: 'hub-abc',
  children,
  ...extra
})
const childTask = (specialist, state = 'running', extra = {}) => ({
  id: `run-${specialist}`,
  generation: 1,
  kind: 'child',
  state,
  specialist,
  hubInstanceId: 'hub-abc',
  ...extra
})

test('the task tree flattens to rows carrying their own depth', () => {
  const view = presentTasks(taskPayload([parentTask([childTask('builder'), childTask('reviewer')])]))

  assert.equal(view.available, true)
  assert.deepEqual(
    view.rows.map(r => [r.depth, r.label]),
    [
      [0, 'turn-1'],
      [1, 'builder'],
      [1, 'reviewer']
    ]
  )
  // The key has to survive a generation bump on the same id, or React reuses
  // the row of a task that was replaced.
  assert.equal(view.rows[1].key, 'hub-abc:run-builder:1')
})

test('only live subagents offer a Cancel, and they are what "running" counts', () => {
  const view = presentTasks(
    taskPayload([
      parentTask([
        childTask('builder', 'running'),
        childTask('reviewer', 'completed'),
        childTask('planner', 'failed'),
        childTask('bowser', 'cancelling')
      ])
    ])
  )

  assert.deepEqual(
    view.rows.filter(r => r.canCancel).map(r => r.label),
    ['turn-1', 'builder', 'bowser']
  )
  // A button that would always 422 is never drawn.
  assert.equal(view.rows.find(r => r.label === 'reviewer').canCancel, false)
  assert.equal(view.running, 3)
})

test('every monitor state has a word and a tone, and an unknown one still renders', () => {
  for (const [state, tone] of [
    ['running', 'good'],
    ['recovering', 'warn'],
    ['failed', 'bad'],
    ['cancelled', 'muted'],
    ['orphaned', 'bad']
  ]) {
    const row = presentTasks(taskPayload([parentTask([childTask('x', state)])])).rows[1]
    assert.equal(row.tone, tone, `${state} tone`)
    assert.notEqual(row.state, '', `${state} label`)
  }

  // A monitor that grows a state must not render a blank cell.
  const future = presentTasks(taskPayload([parentTask([childTask('x', 'quarantined')])])).rows[1]
  assert.equal(future.state, 'quarantined')
  assert.equal(future.tone, 'muted')
  assert.equal(future.canCancel, false)
})

test('no monitor is a sentence, not an empty panel or an alarm', () => {
  const off = presentTasks({ available: false, reason: 'no monitored hub is registered for this profile', tasks: [] })
  assert.equal(off.available, false)
  assert.match(off.note, /no monitored hub/)
  assert.deepEqual(off.rows, [])

  // A hub that simply has not spawned anything is AVAILABLE and empty — a
  // different fact from "there is no monitor", and it has to read that way.
  const idle = presentTasks(taskPayload([]))
  assert.equal(idle.available, true)
  assert.match(idle.note, /has not spawned/)
})

test('a tasks route the running Desktop predates names the restart', () => {
  const missing = presentTasks({ error: 'GET /tasks failed: 404' })
  assert.match(missing.note, /Restart Hermes Desktop/)

  const broken = presentTasks({ error: 'connection reset' })
  assert.equal(broken.note, 'connection reset')
})

test('a child whose parent left the monitor says so instead of posing as a turn', () => {
  const view = presentTasks(taskPayload([{ ...childTask('builder'), orphaned_parent: true, children: [] }]))
  assert.equal(view.rows[0].depth, 0)
  assert.match(view.rows[0].note, /parent no longer/)
})

test('the modal carries the subagent tree and counts the running ones in its one line', () => {
  const target = { project: 'af', name: 'orchestrator' }
  const menu = presentSessionMenu({
    target,
    session: session('orchestrator', 'idle', { workspace_id: 'wA' }),
    tasks: taskPayload([parentTask([childTask('builder'), childTask('reviewer'), childTask('planner', 'completed')])])
  })

  assert.equal(menu.tasks.rows.length, 4)
  // The case the panel used to get wrong: a hub whose own turn is idle while
  // its specialists work read as "nothing is happening".
  assert.match(menu.description, /3 subagents$/)

  const alone = presentSessionMenu({ target, session: session('orchestrator', 'idle', { workspace_id: 'wA' }) })
  assert.doesNotMatch(alone.description, /subagent/)
  assert.equal(alone.tasks.available, false)
})

test('a session that died shows no subagents even with a payload left over', () => {
  const menu = presentSessionMenu({
    target: { project: 'af', name: 'ghost' },
    session: null,
    tasks: taskPayload([parentTask([childTask('builder')])])
  })

  assert.deepEqual(menu.tasks.rows, [])
  assert.doesNotMatch(menu.description, /subagent/)
})
