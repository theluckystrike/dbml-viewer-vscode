-- A small blog schema in PostgreSQL. Open the ER diagram with the button in the editor title bar.

CREATE TYPE post_state AS ENUM ('draft', 'published', 'archived');

CREATE TABLE authors (
  id bigserial PRIMARY KEY,
  email varchar(255) NOT NULL UNIQUE,
  display_name varchar(80) NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id bigserial PRIMARY KEY,
  author_id bigint NOT NULL REFERENCES authors (id) ON DELETE CASCADE,
  title text NOT NULL,
  state post_state NOT NULL DEFAULT 'draft',
  published_at timestamptz
);

CREATE TABLE tags (
  id serial PRIMARY KEY,
  name varchar(40) NOT NULL UNIQUE
);

CREATE TABLE post_tags (
  post_id bigint NOT NULL,
  tag_id integer NOT NULL,
  PRIMARY KEY (post_id, tag_id),
  FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags (id)
);

CREATE TABLE comments (
  id bigserial PRIMARY KEY,
  post_id bigint NOT NULL,
  author_id bigint,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE comments ADD CONSTRAINT comments_post_fk FOREIGN KEY (post_id) REFERENCES posts (id);
ALTER TABLE comments ADD CONSTRAINT comments_author_fk FOREIGN KEY (author_id) REFERENCES authors (id) ON DELETE SET NULL;

CREATE INDEX posts_author_idx ON posts (author_id, published_at DESC);
COMMENT ON TABLE posts IS 'Articles, one row per version that was published';
