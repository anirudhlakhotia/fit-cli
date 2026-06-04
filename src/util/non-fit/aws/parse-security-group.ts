/**
 * parse-security-group — pull the security-group id out of an
 * `aws ec2 describe-security-groups` JSON response. Pure logic, separated from
 * the IO in security-group.ts so it can be unit tested (see
 * tests/parse-security-group.test.ts).
 */

/** Shape of the bits of describe-security-groups we care about. */
export interface DescribeSecurityGroupsResponse {
  SecurityGroups?: Array<{ GroupId?: string; GroupName?: string }>;
}

/**
 * Return the id of the first security group in a describe response, or null if
 * the response lists none (e.g. the group doesn't exist yet).
 */
export function parseSecurityGroupId(response: DescribeSecurityGroupsResponse): string | null {
  return response.SecurityGroups?.[0]?.GroupId ?? null;
}
