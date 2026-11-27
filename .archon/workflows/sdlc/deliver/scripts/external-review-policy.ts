/**
 * Is this delivery's external review gate on?
 *
 * Read once, before any external review node, so a mistyped policy or a missing
 * login refuses here instead of after a paid correction round. Off is the default
 * for every installation; a project opts in through its config's `env:`.
 */

import { externalReviewPolicy } from '../../.shared/external-review.ts';
import { emit, refuse } from '../../.shared/io.ts';

try {
  emit({ mode: externalReviewPolicy().mode });
} catch (error) {
  refuse(`external-review-policy: ${error instanceof Error ? error.message : String(error)}`);
}
