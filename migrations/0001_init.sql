CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE categories (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE expenses (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency IN ('GEL', 'USD')),
  occurred_at timestamptz NOT NULL,
  description text NOT NULL DEFAULT '',
  category_id uuid NOT NULL REFERENCES categories(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_user_occurred_idx ON expenses(user_id, occurred_at DESC, id DESC);
CREATE INDEX expenses_user_category_idx ON expenses(user_id, category_id);

INSERT INTO categories (id, name) VALUES
  ('cbcd0ac9-8d90-4ac9-a811-f868110f2fb1', 'Groceries'),
  ('9f53cfc2-981a-473b-b728-7192ec64ca34', 'Home'),
  ('72444a02-23b4-4962-b49f-d6af26e79f9e', 'Transport'),
  ('804ce471-12c1-4f0f-b75c-c4c631d29257', 'Other');
