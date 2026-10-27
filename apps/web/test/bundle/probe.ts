/**
 * Extra entry of the bundle check (test/bundle.test.ts, ADR-014 Emenda 1). It pulls into a
 * browser build every runtime export of @whodeployed/scenarios "." and the bound `createSession`,
 * whether or not the app already reaches them, so the check covers the whole "." entry. The
 * global write is the side effect that keeps them from being tree-shaken. Never part of dist/.
 */
import * as scenarios from '@whodeployed/scenarios'
import { createSession } from '../../src/session/session'

Object.assign(globalThis, { __whodeployedBundleProbe: { scenarios, createSession } })
