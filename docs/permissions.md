# Roles and permissions

A member's permissions are those of `@everyone` plus every role they hold, as a bitmask in `Role.permissions`. The owner and anyone with `ADMINISTRATOR` can do everything.

`@everyone` is the role whose id equals the guild id. It has rank 0, cannot be renamed, recoloured, reordered or deleted, and is created for older servers on first use.

| Bit | Name | Allows |
| --- | --- | --- |
| `1 << 0` | `ADMINISTRATOR` | everything below, in every channel |
| `1 << 1` | `MANAGE_GUILD` | rename the server and change its description |
| `1 << 2` | `MANAGE_ROLES` | create, edit, reorder and delete roles, and give or take them |
| `1 << 3` | `MANAGE_CHANNELS` | create, edit and delete channels; no slowmode wait |
| `1 << 4` | `MANAGE_EMOJIS` | add, rename and delete custom emoji |
| `1 << 5` | `MANAGE_MESSAGES` | delete other people's messages; no slowmode wait |
| `1 << 6` | `CREATE_INVITE` | create invites |
| `1 << 7` | `KICK_MEMBERS` | remove members from the server |
| `1 << 8` | `SEND_MESSAGES` | write in text channels |
| `1 << 9` | `VIEW_AUDIT_LOG` | read the server's audit log |

`@everyone` starts with `SEND_MESSAGES | CREATE_INVITE`.

Deleting the server and leaving it stay with the owner.

## Hierarchy

Roles are ranked by `position`; a member ranks as their highest role, the owner above all.

- You can edit, delete, give or take a role only if it ranks below you.
- You can remove a member only if they rank below you; nobody can remove the owner.
- You cannot grant a permission you do not hold, whether through a role's bitmask or by giving a role.
- Reordering can move only roles below your own rank.
