// An Elysia app traced by dd-trace-bun. Run it with
//   DD_SERVICE=users-api bun --preload dd-trace-bun/init examples/elysia-app.ts
// Requests from a traced service continue its trace here, and the fetch and database
// calls dd-trace instruments inside handlers become child spans.
import { Elysia } from 'elysia'
import { datadog } from 'dd-trace-bun/elysia'

const app = new Elysia()
  .use(datadog()) // optional: route names for every route, and handler errors on spans
  .get('/users/:id', ({ params }) => ({ id: params.id }))
  .listen(3000)

console.log(`listening on ${app.server!.url}`)
