// Provenance for the TestFlight build the release pipeline is about to bless.
//
// App Store Connect rejects an upload whose CFBundleVersion already exists,
// and Xcode Cloud has usually uploaded the very build this run produced before
// GitHub gets to it, so "duplicate" is normally benign. It is also exactly
// what a phantom release looks like: a build number that was never ours,
// accepted long ago. The build number alone cannot tell those apart. This
// module can: the build TestFlight holds must carry this release's marketing
// version and must have been uploaded after this run's Xcode Cloud build was
// created.

export function parseDate(value) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? new Date(time) : null;
}

export function describeBuild(build, included = []) {
  const preReleaseID = build?.relationships?.preReleaseVersion?.data?.id;
  const preRelease = included.find((item) => item.type === 'preReleaseVersions' && item.id === preReleaseID);
  return {
    id: build?.id,
    number: build?.attributes?.version,
    marketingVersion: preRelease?.attributes?.version ?? null,
    uploadedAt: parseDate(build?.attributes?.uploadedDate),
    processingState: build?.attributes?.processingState,
  };
}

// Picks the newest build that is provably this release's; returns a reason
// when TestFlight holds only builds that are not.
export function selectVerifiedBuild({ builds, included = [], buildNumber, marketingVersion, notBefore }) {
  if (!buildNumber) throw new Error('A build number is required to verify a TestFlight build.');
  if (!marketingVersion) {
    throw new Error('An expected marketing version is required to verify a TestFlight build.');
  }
  const floor = parseDate(notBefore);
  if (!floor) throw new Error('A valid not-before timestamp is required to verify a TestFlight build.');

  const candidates = (builds ?? [])
    .map((build) => describeBuild(build, included))
    .filter((build) => String(build.number) === String(buildNumber));
  if (candidates.length === 0) return { build: null, reason: null };

  const reasons = [];
  for (const candidate of candidates) {
    if (candidate.marketingVersion !== marketingVersion) {
      reasons.push(
        `build ${candidate.number} carries marketing version ${candidate.marketingVersion ?? 'unknown'}, not ${marketingVersion}`,
      );
      continue;
    }
    if (!candidate.uploadedAt || candidate.uploadedAt < floor) {
      reasons.push(
        `build ${candidate.number} was uploaded at ${candidate.uploadedAt?.toISOString() ?? 'an unknown time'}, before this run's Xcode Cloud build was created at ${floor.toISOString()}`,
      );
      continue;
    }
    return { build: candidate, reason: null };
  }
  return { build: null, reason: reasons.join('; ') };
}
