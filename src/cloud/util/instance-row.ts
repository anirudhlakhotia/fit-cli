/** One row of `cloud-instances list`'s combined table — the shared shape aws/instances-cli.ts and gcp/instances-cli.ts both produce so cloud-instances.ts can render one table across both clouds. */
export interface InstanceRow {
  cloud: "AWS" | "GCP";
  id: string;
  address: string;
  state: string;
  creator: string;
}
