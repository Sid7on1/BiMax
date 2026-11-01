# Workspace-aware Mac chats and retrieval recovery

Date: 2026-10-25. Initial status: planned implementation; qualification is pending.

## Inspected causes

The owner's semantic-retrieval notice is a real fallback, not a renderer error. Current user settings
select `all-minilm`, 384 dimensions, at `http://localhost:11434/v1`. Read-only version/model calls both
fail ECONNREFUSED; Ollama and the model manifest are installed but no service process is running.
Keep this private embedding destination and model. Restore the installed service and validate an
actual embedding before reporting recovery. Never send the private corpus to another provider as a fix.

Mac conversations are saved Bimax Threads, each with its own root, even when the Mac window shows
Home. The phone currently strips the root from session summaries, does not offer a project picker,
and its drawer New control always creates a standalone phone chat. Selected route components can
also retain previous conversation/composer state across id changes until asynchronous loading settles.

## Plan and acceptance contract

1. Restore the configured local embedding service; probe valid vectors and a paraphrase/control
   margin with inert text. Improve safe connection/timeout/JSON failure diagnostics without exposing
   credentials, raw provider errors or private text. Preserve lexical fallback and later recovery.
2. Publish bounded Mac-owned workspace ids/labels and existing chat workspace metadata to the
   authenticated paired phone. New Mac chat requires choosing a known folder explicitly, including
   while the Mac is on Home. The phone never supplies an arbitrary filesystem path. With no known
   folder, explain that one must first be added on the Mac. No silent active/previous-chat fallback.
3. Add idempotent create-empty-conversation operation behind existing paired-session/Stop authority.
   Creating saves a fresh Bimax Thread in the selected root without selecting it on the Mac, starting
   an engine or sending a model request. First send addresses that exact new id. Retries reuse one
   creation intent; changed folder requires a new intent. Stop/revocation fences survive asynchronous
   journal waits. Display folder identity beside saved/new Mac chats.
4. Key phone chat owners/renderers/composers by exact source and conversation id. Cancel old async
   loads/subscriptions/sends on retirement, reject mismatched snapshots, and show a genuinely empty
   new canvas rather than briefly painting the previous conversation.
5. Enlarge the readable phone canvas with a persisted Comfortable/Large text choice; keep the actual
   shared Desktop message/Markdown/thinking implementation. Use phone-width layout without nesting
   multiple text-column insets. Preserve code/table/math/diagram/copy/security behavior, keyboard
   space and reduced motion. Changes must be checked at 390-pixel and narrow widths.
6. Add targeted source, wire and actual rendered regressions plus deliberately neutered source checks;
   run focused Desktop and full linked mobile checks, regenerate/export the phone renderer, package
   the changed Desktop responder and preserve user data/signing across installation. Record what
   was actually observed. Native device/roaming/performance remain Target without physical evidence.

Guidance: product-reset README, 03 Product Examples, 04 Frontend Plan, 05 Target Architecture,
08 Acceptance Gates, Mac Buddy vision and records 109–112. Two-product authority is unchanged.
This is not a broad RAG-quality, performance, public-release or competitor claim.

## Delivery record

[Record 114](114_WORKSPACE_CHATS_RETRIEVAL_AND_CANVAS.md) records implemented scope, scoped source/
rendered/encrypted/native-package checks, local embedding recovery, preserved signed installation,
owner-confirmed Mac opening and the remaining physical-phone/roaming/resource/visual Targets.
