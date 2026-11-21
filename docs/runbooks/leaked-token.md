# A leaked token or link

- **A calendar link went too far** (a private feed's link posted publicly): the owner uses "Make a new link" on the share page (`rotate_feed_token`). The old link stops working at once. Current subscribers need the new link.
- **A forwarding address leaked** and receives spam: "Get a new address" on the feed's email page (`rotate_intake_address`). Update the forwarding rule in the mail account.
- **A secret leaked** (in a commit, a screenshot or a chat): see `secret-rotation.md` now. gitleaks runs on every pull request, but a secret that was ever pushed must be rotated even if it's deleted.
