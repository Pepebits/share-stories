# Instagram setup

Getting the two values the bridge needs — `INSTAGRAM_ACCOUNT_ID` and
`INSTAGRAM_ACCESS_TOKEN` — from Meta's developer console.

This is the fiddliest part of the whole project. Meta's own documentation
contradicts its dashboard in places, and there are two near-identical setup
panels where only one will work. The steps below were established by doing it,
not by reading about it.

**You do not need to implement OAuth.** The dashboard mints a 60-day token
directly.

---

## 0. The account must be professional

In the Instagram app: **Settings → Account type and tools → Switch to
professional account**. Either **Business** or **Creator** works; Creator is
the less intrusive of the two.

**No Facebook Page is required.** Avoiding that is the whole reason for
choosing the Instagram Login route below.

## 1. Create the app

At [developers.facebook.com/apps](https://developers.facebook.com/apps) →
**Create app**.

> **The app type must be `Business`.** Any other type cannot add the product in
> step 2, and the type cannot be changed afterwards — you would start over.

## 2. Add the Instagram product

In the app, add the **Instagram** product, then open
**API setup with Instagram business login**.

> ### The trap that costs the most time
>
> The sidebar has two entries with almost the same name:
>
> | Panel | Use it? |
> |---|---|
> | API setup with **Instagram** business login | ✅ this one |
> | API setup with **Facebook** login | ❌ never |
>
> The Facebook panel offers a button labelled *Add required content
> permissions*. Pressing it adds `pages_read_engagement`, `pages_show_list` and
> **`business_management`** — and `business_management` is what triggers the
> "verify your business" wall. It also requires linking a Facebook Page.
>
> You do not need any of that. If you are looking at a panel mentioning
> Facebook Pages, you are in the wrong one.

## 3. Add the publishing permission

The default panel only wires up **messaging** permissions
(`instagram_business_basic`, `..._manage_comments`, `..._manage_messages`).
Publishing is **not** among them, so it has to be added.

Open **Permissions and features** and find:

```
instagram_business_content_publish
```

Note the `_business_` in the middle. There is a similarly named
`instagram_content_publishing` belonging to the Facebook Login flow — that one
needs business verification. This one does not.

You want it at **Standard Access**, shown as **“Ready for testing”**. Standard
Access covers accounts you own or manage and needs neither App Review nor
business verification.

> Ignore the **Advanced Access** column, even if it shows a red cross.
> Advanced Access is only for publishing to *other people's* accounts, and that
> is what demands business verification. It does not apply here.

## 4. Add your account as a tester — and accept it

In the app's **Roles** tab, add your Instagram account as an **Instagram
tester**.

> Then accept the invitation from the Instagram app itself:
> **Settings → Apps and websites → Tester invites**. Until you accept, tokens
> come out without the permissions and the failures are unhelpful.

## 5. Generate the token — last

Back in **API setup with Instagram business login**, press **Generate token**
next to your account, log in, and copy it.

> **Order matters.** A token freezes the permissions in force at the moment it
> is created. Generate it before step 3 and it will not carry publishing rights
> even after you add them. If you already made one, discard it and mint another.

That token is **long-lived: 60 days**. If you read about one-hour tokens, that
is the Business Login flow for apps serving other users — not this.

## 6. The account id

It is shown in the same panel under your account — a long number starting
`17841…`.

Two different ids exist and both work for publishing, which is confusing:

- `GET /me?fields=user_id` → `17841…`, the professional account id
- `GET /me?fields=id` → an app-scoped id

Verified against the live API: `me`, the app-scoped id and the professional id
all resolve to the same account for publishing. Use the `17841…` one.

## 7. Fill in `.env`

```bash
INSTAGRAM_ACCOUNT_ID=17841400000000000
INSTAGRAM_ACCESS_TOKEN=IGAA...
```

A valid token starts with **`IGAA`**. One starting with `EAA` came from the
Facebook Login flow and will not work here.

---

## Checking it worked

```bash
curl -s -G "https://graph.instagram.com/v26.0/me" \
  --data-urlencode "fields=user_id,username" \
  -H "Authorization: Bearer $INSTAGRAM_ACCESS_TOKEN"
```

Your username means the token is valid. To prove the *publishing* permission
without posting anything, ask for a container with a deliberately bad URL:

```bash
curl -s -X POST "https://graph.instagram.com/v26.0/$INSTAGRAM_ACCOUNT_ID/media" \
  -H "Authorization: Bearer $INSTAGRAM_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"media_type":"STORIES","image_url":"https://example.com/nope.jpg"}'
```

- `code 9004`, *"Only photo or video can be accepted as media type"* → **the
  permission works.** Meta tried to fetch the media and found nothing; that is
  as far as this test goes.
- An error mentioning permissions → step 3 or 4 is incomplete.

## Errors you are likely to meet

| Error | Meaning |
|---|---|
| `code 190` | Token invalid, expired or revoked. Mint a new one. |
| `code 9004 / subcode 2207052` | Meta could not fetch your media URL. Usually `PUBLIC_BASE_URL` is unreachable, or the file is not a valid photo/video. |
| Container ends `ERROR` | The media failed Meta's format checks, or the URL was unreachable. The reason is not disclosed. |
| `code 4` | Rate limited. 100 publishes per rolling 24h — and stories count. |

## Token expiry

Tokens die after 60 days. The bridge refreshes automatically once fewer than 14
days remain, storing the current one in `INSTAGRAM_TOKEN_FILE` — so the value in
`.env` is only the start of the chain.

Meta refuses to refresh a token less than 24 hours old. That is expected right
after minting one; the bridge logs it and retries later.

If refreshing still fails with fewer than 7 days left, the bridge sends one
message to the Telegram account's Saved Messages saying a new token has to be
minted by hand before the old one expires. Once a refresh succeeds the alarm
resets, so a later expiry warns again.

To take over by hand, paste a new token into `.env`: the stored chain is
discarded as soon as the seed no longer matches.
