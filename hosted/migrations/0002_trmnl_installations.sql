-- The marketplace conversion: TRMNL owns identity now.
--
-- The hosted tier stops being a Private Plugin that TRMNL polls with a screen
-- key and becomes a third-party plugin that TRMNL installs. Identity arrives as
-- a per-installation access token minted by TRMNL during the install handshake,
-- so the email/password identity provider and the screen key both leave the
-- schema. Bambu sign-in is unchanged: it is the printer credential, not the
-- account system.

CREATE TABLE trmnl_installations (
  -- Ours, random, unguessable. Also the subject the account's owner_tag is
  -- derived from, so the account table needs no new column.
  id text PRIMARY KEY,

  -- A keyed HMAC of the access token TRMNL presents on every markup request,
  -- never the token itself. The token is a bearer credential for our own
  -- surface, so it gets the same treatment the screen key got: stored only in a
  -- form that cannot be replayed if the database leaks.
  access_token_tag text NOT NULL UNIQUE,

  -- TRMNL's identifier for this user-plugin connection, from the success
  -- webhook and every markup request. Null until the success webhook lands.
  -- An identifier: never write it to a log.
  user_uuid text UNIQUE,

  -- Lets a management page deep-link back to trmnl.com/plugin_settings/:id/edit.
  -- Not secret, not identifying on its own, still never logged.
  plugin_setting_id bigint,

  -- The Bambu account this installation configured, once its owner signed in
  -- and picked printers. SET NULL rather than CASCADE in this direction: the
  -- installation outlives a Bambu re-enrolment.
  account_id text UNIQUE REFERENCES accounts(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- The screen key dies with the polling strategy. TRMNL authenticates with its
-- own per-installation token now, so a second bearer credential would be a
-- second thing to leak with nothing left to protect.
ALTER TABLE accounts DROP COLUMN screen_key_fingerprint;
