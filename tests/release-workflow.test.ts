import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

function config(path: string): any {
  return Bun.YAML.parse(readFileSync(path, 'utf8'));
}

describe('production-only release workflow', () => {
  test('feature PRs receive CI and CodeRabbit review directly on main', () => {
    const ci = config('.github/workflows/ci.yml');
    const review = config('.coderabbit.yaml');
    expect(ci.on.pull_request.branches).toEqual(['main']);
    expect(ci.on.push.branches).toEqual(['main']);
    expect(review.reviews.auto_review.enabled).toBe(true);
    expect(review.reviews.auto_review.base_branches).toEqual(['main']);
    expect(review.reviews.request_changes_workflow).toBe(true);
    const commands = ci.jobs.checks.steps.map((step: any) => step.run).filter(Boolean);
    for (const command of [
      'bun run typecheck',
      'bun run typecheck:tests',
      'bun run lint',
      'bun run test:coverage',
      'bun run build',
    ]) {
      expect(commands).toContain(command);
    }
  });

  test('only main deploys the hosted stack, with Convex before Railway', () => {
    const deploy = config('.github/workflows/deploy-production.yml');
    expect(deploy.on.push.branches).toEqual(['main']);
    expect(deploy.jobs.release.environment).toBe('production');
    const steps = deploy.jobs.release.steps;
    const convex = steps.findIndex((step: any) => step.name === 'Deploy Convex');
    const railway = steps.findIndex((step: any) => step.name === 'Deploy Railway production');
    expect(convex).toBeGreaterThan(-1);
    expect(railway).toBeGreaterThan(convex);
    expect(steps[railway].run).toContain('--environment production');
    expect(existsSync('.github/workflows/deploy-development.yml')).toBe(false);
    expect(existsSync('.github/workflows/xcode-cloud-staging.yml')).toBe(false);
  });

  test('native acceptance stays on feature PRs while distribution follows production', () => {
    const acceptance = config('.github/workflows/native-acceptance.yml');
    const distribution = config('.github/workflows/xcode-cloud-production.yml');
    expect(acceptance.on.pull_request.branches).toEqual(['main']);
    expect(acceptance.jobs.native.strategy.matrix.platform).toEqual(['ios', 'macos']);
    expect(distribution.on.workflow_run.workflows).toEqual(['Deploy Production']);
  });
});
