# Optional OpenViking memory service

This Compose file runs OpenViking as a separate, loopback-only local service for
Kyrei. Kyrei itself stays fully functional with its built-in SQLite/project
memory when this service is absent.

OpenViking's main project is AGPLv3. This repository does not vendor its code;
the Compose file only starts the upstream image through an optional HTTP
adapter.

From the repository root:

```powershell
docker compose -f docker/openviking/compose.yml up -d
docker exec -it kyrei-openviking openviking-server init
curl http://127.0.0.1:1933/health
```

The first command starts the container in setup-wait mode when no `ov.conf`
exists. The second command runs OpenViking's own setup wizard and writes its
configuration to the Docker-managed `kyrei-openviking-data` volume, outside the
repository. Configure a strong `root_api_key` in that wizard: upstream requires
one for Docker deployments.

The container is bound only to `127.0.0.1` and starts without VikingBot. Do not
change the port binding to `0.0.0.0` unless you deliberately add authentication,
TLS, and network controls outside Kyrei.
