# terraform state note

This directory's `.tf` files describe `fit-cli-vpc` and the parts of `fit-cli-role`
that private endpoint testing needs. They were already applied to real AWS
infra (as part of the broader ssh-to-ssm-transport branch's terraform work,
which also adds SSM-specific resources not included here) — the state file
currently lives only in that branch's worktree.

Do not run `terraform apply` from this worktree until state ownership is
reconciled at merge time (either merge ssh-to-ssm-transport first, or `terraform
import` the already-existing resources here). Running `apply` against a fresh,
empty state now would try to create duplicate resources.
