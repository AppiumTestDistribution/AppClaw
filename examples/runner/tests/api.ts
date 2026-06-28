/**
 * Stand-in for a real backend.
 *
 * In a real project these would be `fetch()` calls to your API
 * (`POST /users`, `DELETE /users/:id`). Here they synthesize a user locally so
 * the example runs without a server — swap the bodies for real requests.
 */

/** The data your test needs about the provisioned user. */
export interface ApiUser {
  id: string;
  email: string;
  password: string;
}

let seq = 0;

/** "Create" a test user. Replace with a real `POST /users` in your project. */
export async function createUser(label: string): Promise<ApiUser> {
  const n = ++seq;
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  // const res = await fetch('https://api.example.com/users', { method: 'POST', … });
  // return (await res.json()) as ApiUser;
  return {
    id: `u_${slug}_${n}`,
    email: `qa+${slug}-${n}@example.com`,
    password: 'P@ssw0rd!',
  };
}

/** "Delete" the user. Replace with a real `DELETE /users/:id` in your project. */
export async function deleteUser(user: ApiUser): Promise<void> {
  // await fetch(`https://api.example.com/users/${user.id}`, { method: 'DELETE' });
  void user; // no-op for the local stand-in
}
