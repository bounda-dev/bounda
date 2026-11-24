DATABASE_URL=postgres://user:password@localhost:5432/{{name}}
# Where the tenant's key is: another database than DATABASE_URL, which its backups never carry.
# Forgetting the tenant destroys the key there.
TENANT_KEYS_URL=postgres://user:password@localhost:5432/{{name}}_keys
# Where the record of whom the app forgot is: another database than DATABASE_URL, which its
# restores never touch, so a restored backup forgets again whoever it brings back.
FORGET_LEDGER_URL=postgres://user:password@localhost:5432/{{name}}_ledger

# BOUNDA_MASTER_KEY is in .env already, generated for this project: add DATABASE_URL, TENANT_KEYS_URL and
# FORGET_LEDGER_URL there rather than copying this file over it, or the master key is lost with what it wrapped.
