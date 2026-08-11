resource "google_compute_firewall" "fit_cli_allow_iap_ssh" {
  name    = "fit-cli-allow-iap-ssh"
  network = google_compute_network.fit_cli.id

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  # Google's documented, fixed range for IAP TCP forwarding.
  source_ranges = ["35.235.240.0/20"]
}

# Lets instances doing Private Service Connect (PSC) testing reach the PSC
# endpoint that `cbdinocluster private-endpoints setup-link` creates — it lands
# in this same subnet. Scoped to instances tagged fit-cli-private-endpoint
# (see PRIVATE_ENDPOINT_NETWORK_TAG in src/fit/util/gcp/fit-instance.ts)
# rather than opened for every fit-cli box, mirroring how the AWS side only
# attaches its VPC default SG when a run asks for a private endpoint.
resource "google_compute_firewall" "fit_cli_allow_private_endpoint" {
  name    = "fit-cli-allow-private-endpoint"
  network = google_compute_network.fit_cli.id

  allow {
    protocol = "all"
  }

  source_ranges = [google_compute_subnetwork.fit_cli_us_west1.ip_cidr_range]
  target_tags   = ["fit-cli-private-endpoint"]
}
