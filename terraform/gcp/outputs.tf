output "fit_cli_gcp_project_id" {
  description = "Paste into environments.json5 -> defaults.gcp.project"
  value       = var.gcp_project_id
}

output "fit_cli_gcp_network_name" {
  description = "Paste into environments.json5 -> defaults.gcp.network"
  value       = google_compute_network.fit_cli.name
}

output "fit_cli_gcp_subnet_name" {
  description = "Paste into environments.json5 -> defaults.gcp.subnet"
  value       = google_compute_subnetwork.fit_cli_us_west1.name
}

output "fit_cli_gcp_service_account_email" {
  description = "The service account src/cloud/util/gcp/create-instance.ts should attach to launched instances (CreateGcpInstanceSpec.serviceAccountEmail)."
  value       = google_service_account.fit_cli_gcp.email
}

output "fit_cli_gcp_workload_identity_provider" {
  description = "Paste into .github/workflows/cleanup-instances.yaml's google-github-actions/auth 'workload_identity_provider' input."
  value       = "projects/${data.google_project.current.number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}/providers/${google_iam_workload_identity_pool_provider.github.workload_identity_pool_provider_id}"
}
