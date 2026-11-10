'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parsePrisma } = require('../src/core/prisma');

const SRC = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

/// A person who can sign in
model User {
  id      Int      @id @default(autoincrement())
  email   String   @unique @db.VarChar(255)
  name    String?
  role    Role     @default(USER)
  posts   Post[]
  profile Profile?
  @@map("users")
}

model Profile {
  id     Int  @id
  user   User @relation(fields: [userId], references: [id], onDelete: Cascade)
  userId Int  @unique
}

model Post {
  id         Int        @id
  author     User       @relation("written", fields: [authorId], references: [id], onDelete: SetNull)
  authorId   Int?
  categories Category[]
  @@index([authorId])
}

model Category {
  id    Int    @id
  posts Post[]
}

enum Role {
  USER
  ADMIN
}
`;

test('Prisma: models, scalar columns, @relation, one-to-one by @unique, implicit many-to-many, enum, datasource', () => {
  const m = parsePrisma(SRC);
  assert.deepStrictEqual(m.errors, []);
  assert.deepStrictEqual(m.tables.map((t) => t.key), ['User', 'Profile', 'Post', 'Category']);
  const u = m.tables[0];
  assert.deepStrictEqual(u.columns.map((c) => c.name), ['id', 'email', 'name', 'role'], 'relation fields are not columns');
  assert.ok(u.columns[0].pk && u.columns[0].increment);
  assert.strictEqual(u.columns[1].type, 'VarChar(255)');
  assert.ok(!u.columns[2].notNull);
  assert.strictEqual(u.columns[3].enumRef, 'Role');
  assert.match(u.note, /A person who can sign in/);
  assert.match(u.note, /Table: users/);
  const r = m.refs.map((x) => `${x.from.table}.${x.from.columns}${x.rel}${x.to.table}.${x.to.columns} ${x.onDelete}`).sort();
  assert.deepStrictEqual(r, ['Post.authorId>User.id set null', 'Post.id<>Category.id ', 'Profile.userId-User.id cascade']);
  assert.strictEqual(m.project.databaseType, 'postgresql');
  assert.deepStrictEqual(m.tables[2].indexes[0].columns, [{ name: 'authorId' }]);
});

test('Prisma: unknown types and a missing } are errors with a line', () => {
  const m = parsePrisma('model A {\n  id Int @id\n  b Blob\n');
  assert.ok(m.errors.some((e) => e.line === 3 && /Unknown type "Blob"/.test(e.message)));
  assert.ok(m.errors.some((e) => /no closing/.test(e.message)));
});
