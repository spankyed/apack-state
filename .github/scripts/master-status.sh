#!/usr/bin/env bash
# What a workflow run on master says where it is seen: a run that failed opens an issue named for the workflow, or
# comments on the one already open; a run that passed closes it. One issue a workflow, open for as long as master
# fails it, so a failure shows on the repository and in its owner's notifications, not at the next pull request.
#
#   master-status.sh <passed|failed>   (GH_TOKEN, GH_REPO, WORKFLOW, RUN_URL and SHA from the job)
set -euo pipefail
result="$1"
title="master fails: $WORKFLOW"
open="$(gh issue list --state open --search "in:title \"$title\"" --json number,title --jq "map(select(.title == \"$title\"))[0].number // empty")"
if [ "$result" = failed ]; then
  body="$RUN_URL failed on $SHA."
  if [ -n "$open" ]; then gh issue comment "$open" --body "$body"; else gh issue create --title "$title" --body "$body"; fi
elif [ -n "$open" ]; then
  gh issue close "$open" --comment "$RUN_URL passed on $SHA."
fi
