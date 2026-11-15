DATABASE_URL=postgres://user:password@localhost:5432/{{name}}
# Where the tenant's key is: another database than DATABASE_URL, which its backups never carry.
# Forgetting the tenant destroys the key there.
TENANT_KEYS_URL=postgres://user:password@localhost:5432/{{name}}_keys

# BOUNDA_MASTER_KEY is in .env already, generated for this project: add DATABASE_URL and TENANT_KEYS_URL there rather
# than copying this file over it, or the master key is lost with what it wrapped.
