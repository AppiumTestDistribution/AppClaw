import { test as base } from 'appclaw/runner';
import type { AppClaw } from 'appclaw';
import { tapLogin } from './steps.js';
import { createUser, deleteUser, type ApiUser } from './api.js';

/**
 * Demonstrates the three things tests usually need:
 *  - deviceLabel → worker-scoped: built ONCE per device, reused across its tests
 *  - loggedInApp → test-scoped:   taps login fresh for every test
 *  - apiUser     → test-scoped:   provisions data via an API and RETURNS it
 *                                  (the test reads it back by destructuring)
 *
 * A fixture hands its data to the test by passing it to `use(value)`; the test
 * then destructures that value by the fixture's name. Built-ins like `device`
 * are always available to both fixtures and tests.
 */
export const test = base.extend<{
  loggedInApp: AppClaw;
  deviceLabel: string;
  apiUser: ApiUser;
}>({
  deviceLabel: [
    async ({ device }, use) => {
      console.log(`  [worker] deviceLabel setup for ${device.name}`);
      await use(device.name);
      console.log(`  [worker] deviceLabel teardown for ${device.name}`);
    },
    { scope: 'worker' },
  ],

  loggedInApp: async ({ app }, use) => {
    console.log('  [test]   loggedInApp setup → tapLogin');
    await tapLogin(app);
    await use(app);
    console.log('  [test]   loggedInApp teardown');
  },

  // Provision a user through your backend, hand the data to the test, clean up
  // after. `device` is available here too (e.g. to tag the user per device).
  apiUser: async ({ device }, use) => {
    const user = await createUser(device.name); // setup — POST /users
    console.log(`  [test]   apiUser created ${user.email}`);
    await use(user); // ← the test receives this object
    await deleteUser(user); // teardown — DELETE /users/:id
    console.log(`  [test]   apiUser deleted ${user.id}`);
  },
});
