import { test } from './fixtures.js';

test('list is visible after login', async ({ loggedInApp }) => {
  await loggedInApp.verify('the list if visible');
});

test('slider shows two green dots', async ({ loggedInApp }) => {
  await loggedInApp.run('Click on slider');
  await loggedInApp.verify('two green dot is visisble');
});
