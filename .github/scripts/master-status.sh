#!/usr/bin/env bash
# What a workflow run on master says where it is seen: a run that failed opens an issue named for the workflow, or
# comments on the one already open; a run that passed closes it. One issue a workflow, open for as long as master
# fails it, so a failure shows on the repository and in its owner's notifications, not at the next pull request.
#
#   master-status.sh <passed|failed>   (GH_TOKEN, GH_REPO, WORKFLOW, RUN_URL and SHA from the job)
set -euo pipefail
result="${1:-}"
if [ "$result" != passed ] && [ "$result" != failed ]; then
  echo "Expected passed or failed, got: ${result:-<empty>}" >&2
  exit 1
fi
# Only speak for what master is at now: a manual re-run of an older commit must not reopen or close the issue after a
# newer push already settled it.
head="$(gh api "repos/$GH_REPO/git/ref/heads/master" --jq '.object.sha')"
if [ "$head" != "$SHA" ]; then
  echo "Skipping: $SHA is no longer master HEAD ($head)."
  exit 0
fi
title="master fails: $WORKFLOW"
# The Issues REST endpoint, not search: search lags behind a just-opened issue, and filtering by creator keeps a
# public repository's users from colliding with it.
open="$(gh api --paginate "repos/$GH_REPO/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100" | jq -r --arg title "$title" '.[] | select(.pull_request == null and .title == $title) | .number')"
if [ "$result" = failed ]; then
  body="$RUN_URL failed on $SHA."
  first="${open%%$'\n'*}"
  if [ -n "$first" ]; then
    gh issue comment "$first" --body "$body"
  else
    gh issue create --title "$title" --body "$body"
  fi
elif [ -n "$open" ]; then
  while IFS= read -r number; do
    if [ -n "$number" ]; then
      gh issue close "$number" --comment "$RUN_URL passed on $SHA."
    fi
  done <<< "$open"
fi
