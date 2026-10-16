import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Bots trade their emoji for a robot avatar that clients draw in the bot's color. Captain
 * gets the first starter avatar; every other bot gets one by its rail position.
 */

// Stored as written; a migration's data never changes.
const AVATARS = [
  '{"head":"squircle","face":"visor","eyes":"round","top":"ball","cheeks":false,"smile":true}',
  '{"head":"round","face":"plate","eyes":"happy","top":"bow","cheeks":true,"smile":false}',
  '{"head":"wide","face":"visor","eyes":"visor","top":"headphones","cheeks":false,"smile":false}',
  '{"head":"cat","face":"bare","eyes":"big","top":"none","cheeks":true,"smile":true}',
  '{"head":"tall","face":"plate","eyes":"tall","top":"propeller","cheeks":false,"smile":true}',
  '{"head":"dome","face":"visor","eyes":"star","top":"halo","cheeks":true,"smile":false}',
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bots RENAME COLUMN emoji TO avatar_json`;
  const bots = yield* sql<{ readonly id: string }>`
    SELECT id FROM bots ORDER BY id = 'bot-captain' DESC, position, created_at, id
  `;
  for (const [index, bot] of bots.entries()) {
    const avatar = AVATARS[index % AVATARS.length]!;
    yield* sql`UPDATE bots SET avatar_json = ${avatar} WHERE id = ${bot.id}`;
  }
});
