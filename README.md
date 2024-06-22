To install dependencies:

```sh
bun install
```

To run:

```sh
bun run dev
```

open http://localhost:3000

To expose on port 80 run this command from root project directory:

```sh
docker run -it -d --restart unless-stopped --name proxy -v .:/home/bun/app -p 3000:3000 -p 80:3000 oven/bun bun dev
```

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
