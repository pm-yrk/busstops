# Data subject requests

## What is actually held

Very little, deliberately:

- **Passengers**: nothing server-side. Favourites and preferences live in the browser's own
  storage and never leave the device. Location used for a journey plan is used for that request
  and is not logged or stored.
- **Daily Brief recipients**: email address, verification and opt-in timestamps, timezone,
  delivery time, chosen scope, and an unsubscribe token **hash**. Plus consent events and send
  records.
- **Vehicles**: opaque references salted with a secret that rotates every service day, so a trace
  cannot be joined to yesterday's. Raw positions expire automatically within 48 hours and there is
  no Replay feature and no long-term raw archive.

## Someone asks what you hold

For a recipient: their row, their consent events, and their send records. That is the complete
set. For a passenger with no subscription, the honest answer is that there is nothing to disclose,
and their favourites are in their own browser where they can export them.

## Someone asks for deletion

1. Delete the recipient row, which removes the address, the token hash and the preferences.
2. Retain the consent events, which are the record that consent was given and withdrawn — keeping
   them is what lets you demonstrate the deletion was lawful and honoured.
3. Send records reference a recipient id, not an address, and age out on their own.

Deletion runs in every governor state. It is mandatory work, like raw expiry.

## What not to do

- Do not attempt to identify a driver or an individual vehicle from the data. The salt exists to
  make that impossible, and defeating it would be a design change, not an investigation.
- Do not add raw IP addresses or precise location to consent audit context. The field is
  deliberately non-identifying.
