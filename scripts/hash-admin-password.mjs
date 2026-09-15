#!/usr/bin/env node
// Read a password from stdin so it never appears in process arguments.
import { hashAdminPassword } from '../server/admin.mjs';
let password = '';
for await (const chunk of process.stdin) { password += chunk; if (Buffer.byteLength(password) > 1026) throw new Error('Password is too long.'); }
console.log(await hashAdminPassword(password.replace(/\r?\n$/, '')));
