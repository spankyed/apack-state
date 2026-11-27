<!--
Plain words, short sentences. Say what holds, not how it was built. Delete what does not apply.
-->

## What is here

<!-- What changed, as what now holds. A decision the design changes is in docs/plan.md and docs/design.md as well. -->

## Design bar

<!--
Required whenever `src/kernel.ts` or `etc/*.api.md` changes; delete if neither changed.
- Consumer leverage: which real `apack` call sites does this simplify, and what workaround does it delete?
- Surface minimalism: if `etc/*.api.md` adds an export or `Def` key, why could it not live on an existing one?
- False-positive check: what valid program could this reject, block, or surprise?
- Precedent: how does this fit `apack-state`'s own mechanisms (`RUNAWAY`, standing vs. imperative) and actor/RPC precedent?
-->

## How it is known to hold

<!--
The cases that hold it, by name. Where the cases change in number or wording, how you know none was dropped: count
them before and after, by name.

What order it depends on is checked under the schedule, every ordering where that is feasible and a seed's worth
where it is not.
-->

## Mutants

<!--
What was changed in a copy of the tree, one at a time, and what caught each: | Changed | Caught by |. A change no
case noticed is a case to write, or, where no case could tell it from the code, why. Never on the working tree, and
never on code that kills, signals or runs a process.
-->

## For you to decide

<!-- Anything that is the owner's to choose, with the options. Leave out if there is nothing. -->

## Checks

- [ ] `npm run lint`
- [ ] `npm run typecheck` and `npm run typecheck:floor`
- [ ] `npm run api:check`, `npm run graph:check`, `npm run errors:check`
- [ ] `npm test` and `npm run test:browser`
- [ ] `npm run build`, `npm run package:smoke` and `npm run package:lint`
- [ ] `npm run workflows:check` and `npm run deps:check`
