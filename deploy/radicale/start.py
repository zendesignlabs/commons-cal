"""Create a runtime-only password hash for the dedicated Commons account."""
import os
import re
import bcrypt

username = os.environ['RADICALE_ACCOUNT_USERNAME']
password = os.environ.pop('RADICALE_ACCOUNT_PASSWORD').encode('utf-8')
if not re.fullmatch(r'[A-Za-z0-9_-]+', username):
    raise SystemExit('Use only letters, numbers, hyphens, or underscores for the account name.')
if not 32 <= len(password) <= 72:
    raise SystemExit('Generate a 32–72 byte backend password; see README.md.')
os.umask(0o077)
with open('/tmp/commons-users', 'w', encoding='utf-8') as users:
    users.write(username + ':' + bcrypt.hashpw(password, bcrypt.gensalt()).decode('ascii') + '\n')
os.execvp('radicale', ['radicale', '--config', '/etc/radicale/config'])
