To install dependencies:

```sh
bun install
```

To run:

```sh
bun run dev
```

open http://localhost:3000

### Exposing over HTTP port 80 with docker

To expose on port 80 run this command from root project directory:

```sh
docker run -it -d --restart unless-stopped --name proxy -v .:/home/bun/app -p 3000:3000 -p 80:3000 oven/bun bun dev
```

### Autoheal

to add healtcheck to proxy container add healthcheck configuration options

```sh
docker run -it -d --restart unless-stopped --name proxy -v .:/home/bun/app -p 3000:3000 -p 80:3000 --health-cmd "bun run src/healthcheck.ts" --health-interval 10s --health-retries 3 oven/bun bun dev
```

then to automatically restart the container when it is marked as unhealthy run this image in the background

```sh
docker run -d --name autoheal --restart=always -e AUTOHEAL_CONTAINER_LABEL=all -v /var/run/docker.sock:/var/run/docker.sock willfarrell/autoheal
```

### Useful docker commands

Proxy should hot reload when updating any imported file but in case it does not, you can restart manually:

```sh
docker restart proxy
```

To watch current logs:

```sh
docker logs -f proxy
```

To view all logs from last hour:

```sh
docker logs --since 1h proxy
```
