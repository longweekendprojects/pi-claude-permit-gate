# OAuth refresh rejection and an unsafe credential writer

## Conclusion

Pi attempted to refresh Claude Account D automatically. Anthropic rejected the submitted refresh token with HTTP 400, `invalid_grant`, and `Refresh token expired`. The error concerns the refresh token, not merely the short-lived access token.

The allowance prober contains a confirmed concurrency defect that can leave Pi holding an obsolete refresh token. It rotates credentials and replaces `auth.json` without acquiring Pi's credential lock. A concurrent Pi credential update can erase the prober's replacement token, including when the two processes update different accounts. An isolated reproduction using the installed Pi credential store and the prober's actual refresh function demonstrated this lost update.

This establishes a real defect, not the historical cause of this particular rejection. The available logs do not identify which operation invalidated Account D's rejected refresh token. Genuine expiration, revocation, an unpersisted refresh, or use of a copied credential elsewhere remain possible. Do not describe the race as a proven incident root cause.

The operator requested diagnosis only. No runtime source, installed package, credential, configuration, or running service was changed. Diagnostic documentation is the only persistent repository change.

## Relevant implementation

The inspected repository was at `3334e55b716e49c053c834c98482350441885c53`. The installed Pi coding agent and Pi AI versions were both `0.87.1`.

- `scripts/allowance-prober.mjs:52` reads all credentials into a process-local snapshot before checking the accounts.
- `scripts/allowance-prober.mjs:56–67` submits the snapshot's refresh token directly to Anthropic and constructs replacement credentials.
- `scripts/allowance-prober.mjs:68–72` rereads the file, replaces one account in that snapshot, and renames a temporary file over `auth.json`. It never acquires Pi's lock.
- `scripts/allowance-prober.mjs:203–218` calls this refresh path when its saved access-token expiry has elapsed.
- Pi's `dist/core/auth-storage.js:116–145` holds a `proper-lockfile` lock across the read, asynchronous modification, and persistence.
- Pi's `dist/core/auth-storage.js:378–394` merges a modified account into the file snapshot it read under that lock. This is safe only when every writer respects the lock.
- Pi AI's `dist/auth/resolve.js:69–111` checks OAuth expiry, rereads the credential under the storage lock, refreshes when needed, and persists the returned credential. It skips refresh if another cooperating process already refreshed it.
- `~/.pi/agent/extensions/anthropic-account-lanes/anthropic-oauth.ts:72–84` delegates account refresh to Pi's canonical Anthropic implementation. It does not implement a separate token store.

The launchd job at `~/Library/LaunchAgents/com.longweekendprojects.claude-allowance-prober.plist` runs the installed prober every 90 seconds. Its installed script and this repository's script had the same SHA-256: `fc5c946f56990ed5c1f339d4c3d37f4331f841269806a544447d7bec34205cbb`.

Atomic rename prevents a reader from seeing a partially written prober file. It does not serialize writers or protect replacement refresh tokens from lost updates.

## Demonstrated failure sequence

1. Pi acquires its credential lock and reads the whole file to refresh Account A.
2. Pi waits for the Account A refresh response while holding that lock.
3. The prober ignores the lock, refreshes Account D, and saves D's replacement token.
4. Pi receives A's response and writes A's replacement credential into its earlier whole-file snapshot.
5. That write restores D's obsolete credential and erases D's replacement token.
6. D's next automatic refresh submits the obsolete token. A server that invalidates the predecessor rejects it.

The prober's reread before its own write does not prevent step 4. Pi already holds an earlier snapshot. There is also a reverse lost-update window if Pi writes after the prober's reread but before its rename. For the same account, the prober can submit a refresh token that another process has already rotated because it does not reread under a shared lock before the request.

## Incident evidence

All timestamps below are UTC on 2026-09-24 unless stated otherwise.

- Session `01a09157-fe41-7791-a942-45dc2664cc3c`, record 4033, reports the Account D rejection at `17:22:26.732`.
- Session `01a0b64f-4543-7205-8893-97813a4d2104`, record 1728, reports the same rejection at `17:23:51.822`.
- The allowance prober continued to obtain successful D usage responses at `17:22:36.469` and `17:24:07.547`. A still-valid access token does not establish that its refresh token is valid.
- The most recent logged prober refresh for D was at `2026-09-23T09:55:53.548Z`, not at the time of this incident. The prober refreshed B at `10:27:21.090` and C at `16:20:28.664` on September 24. These entries do not prove that an overlapping credential write occurred.
- A read-only metadata inspection after the incident found D's saved access expiry at `2026-09-25T01:20:47.935Z`; the auth file modification time was `2026-09-24T17:25:47.941Z`. Something outside this investigation had already updated the file. The metadata does not distinguish login from refresh or prove that the replacement refresh token works.
- The four saved account refresh tokens were distinct at inspection. No token values were printed or persisted by this investigation.

Session files are under `~/.pi/agent/sessions/--Users-albert-Work-recora-health-back-end-apps-worldbuilder--/`. Prober evidence is in `~/Library/Logs/Claude Permit Authority/claude-allowance-prober.log`, especially records 11467 and 11508–11511.

## Isolated reproduction

The following diagnostic ran successfully. It uses the real installed Pi storage implementation, the real Pi OAuth resolver, and the prober's refresh function at `3334e55b716e49c053c834c98482350441885c53`. All credentials are synthetic, all HTTP responses are mocked, and the auth store is temporary. The rest of the prober is not evaluated, so no Keychain, authority, usage, or live OAuth operation runs. The mock server models refresh-token rotation; it does not measure Anthropic's live rotation or grace-period policy.

Run from the repository root:

```bash
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const runtime='/Users/albert/.local/share/mise/installs/node/25.9.0/lib/node_modules/@earendil-works/pi-coding-agent';
const { AuthStorage } = await import(pathToFileURL(`${runtime}/dist/core/auth-storage.js`).href);
const { resolveProviderAuth } = await import(pathToFileURL(`${runtime}/node_modules/@earendil-works/pi-ai/dist/auth/resolve.js`).href);
const source=execFileSync('git',['show','3334e55b716e49c053c834c98482350441885c53:scripts/allowance-prober.mjs'],{encoding:'utf8'});
const start=source.indexOf('async function refreshProvider(provider) {');
const end=source.indexOf('// While this machine is bypassed',start);
assert(start>=0 && end>start);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pi-oauth-diagnosis-'));
const authPath=path.join(temp,'auth.json');
const expired=(id)=>({type:'oauth',refresh:`fake-${id}-old`,access:`fake-${id}-access-old`,expires:1});
const fresh=(id)=>({type:'oauth',refresh:`fake-${id}-new`,access:`fake-${id}-access-new`,expires:Date.now()+28_800_000});
try {
  const initial={'anthropic-a':expired('a'),'anthropic-d':expired('d')};
  fs.writeFileSync(authPath,JSON.stringify(initial),{mode:0o600});
  const store=AuthStorage.create(authPath);
  const entered=Promise.withResolvers();
  const continuePi=Promise.withResolvers();
  const piWrite=store.modify('anthropic-a', async () => {
    entered.resolve();
    await continuePi.promise;
    return fresh('a');
  });
  await entered.promise;
  assert(fs.existsSync(`${authPath}.lock`));
  let serverRefresh='fake-d-old';
  const context=vm.createContext({
    auth:structuredClone(initial),fs,AUTH_FILE:authPath,
    TOKEN_URL:'https://example.invalid/fake-token',CLIENT_ID:'fake-client',
    process:{pid:process.pid},Date,
    fetch:async (_url,options)=>{
      const body=JSON.parse(options.body);
      assert.equal(body.refresh_token,serverRefresh);
      serverRefresh='fake-d-new';
      return {ok:true,json:async()=>({access_token:'fake-d-access-new',refresh_token:serverRefresh,expires_in:28_800})};
    },
  });
  vm.runInContext(source.slice(start,end),context);
  await vm.runInContext('refreshProvider("anthropic-d")',context);
  assert.equal(JSON.parse(fs.readFileSync(authPath,'utf8'))['anthropic-d'].refresh,'fake-d-new');
  console.log('PASS: Actual prober refresh function wrote auth.json while the actual Pi credential lock was held.');
  continuePi.resolve();
  await piWrite;
  assert.equal(JSON.parse(fs.readFileSync(authPath,'utf8'))['anthropic-d'].refresh,'fake-d-old');
  console.log('PASS: Pi persisted lane A from its locked snapshot and erased the prober\'s rotated lane D credential.');
  const provider={id:'anthropic-d',auth:{oauth:{
    refresh:async credential=>{
      if (credential.refresh!==serverRefresh) throw new Error('HTTP 400: invalid_grant: Refresh token expired');
      return fresh('d');
    },
    toAuth:async credential=>({apiKey:credential.access}),
  }}};
  await assert.rejects(resolveProviderAuth(provider,store,{}),/OAuth refresh failed for anthropic-d.*invalid_grant/);
  console.log('PASS: The actual Pi resolver then failed automatic refresh with the same invalid_grant error class.');
} finally {
  fs.rmSync(temp,{recursive:true,force:true});
}
NODE
```

All three assertions passed. This reproduction proves loss of the replacement credential under the demonstrated schedule, not that this schedule occurred in the reported session.

## Recommended correction, not implemented

Make the prober use Pi's canonical OAuth resolver and credential store so all account updates share the same lock, reread, expiry check, refresh, and persistence transaction. Locking only the final write is insufficient: the submitted refresh token must also be read and checked while the lock is held. Extra retries cannot recover a replacement refresh token that has already been discarded.

Before any live correction, add isolated coverage for concurrent updates to the same account, updates to different accounts, and a token refreshed between the prober's initial read and its turn to use that account. Do not rotate or reauthenticate live credentials merely to reproduce the race.
