import type { Payload, PayloadRequest, Where } from 'payload'

export const GROUPS = 'share-groups'
export const MEMBERS = 'share-members'
export const EVENTS = 'share-member-events'

export type Role = 'owner' | 'manager' | 'viewer'
export type MemberStatus = 'invited' | 'active' | 'removed'

/** Who a membership belongs to: a document in one of the host's member collections (users, organizations). */
export type MemberRef = { relationTo: string; value: string | number }

export type LevelConfig = { value?: string; label?: string }

/** What the plugin settled on, kept in `config.custom.sharing` so the helpers need no global state. */
export type ResolvedSharing = {
  users: string
  memberTypes: string[]
  levels: Record<Role, { value: string; label: string }>
  kinds: { value: string; label?: string }[]
  identities?: SharingOptions['identities']
}

export type ShareGroup = {
  id?: string | number
  name: string
  kind: string
  owner: MemberRef
}

export type ShareMember = {
  id?: string | number
  group: string | number
  member: MemberRef
  /** The stored level value (by default `owner`, `manager` or `viewer`). */
  level: string
  status: MemberStatus
  invitedBy?: string | number | null
  acceptedAt?: string | null
  removedAt?: string | null
  removedBy?: string | number | null
  notes?: string | null
}

type User = { id: string | number; collection?: string } & Record<string, unknown>

export type GroupArgs = {
  req: PayloadRequest
  user: User
  /** The group being created. */
  data: Partial<ShareGroup>
}

export type MemberArgs = {
  req: PayloadRequest
  user: User
  group: ShareGroup & { id: string | number }
  /** The id of the membership being changed. Absent when one is being created. */
  id?: string | number
  /** The membership as it is now, or for an invitation what is being created. Ids are plain, never `{ id }` objects. */
  member: Partial<ShareMember>
  /** The fields being sent: the whole invitation, or only what a change touches. Normalized the same way. */
  data: Partial<ShareMember>
  /** The role the asker holds in this group (through themselves or an identity), or null if none. */
  actorRole: Role | null
  /** For `canChangeLevel`: the level it would become. */
  to?: string
}

export type RefuseArgs = {
  req: PayloadRequest
  group: ShareGroup & { id: string | number }
  /** The member's own document (the user or organization). */
  subject: Record<string, unknown> & { id: string | number }
  ref: MemberRef
  level: string
  action: 'invite' | 'accept' | 'change-level'
  /** The signed-in user making the change, or null for server code. */
  actor: ({ id: string | number } & Record<string, unknown>) | null
  /**
   * Set when the member is an organization: the veto is asked once for the organization itself, and once for each person
   * `peopleOf` lists behind it, with `subject` the person and `via` the organization.
   */
  via?: MemberRef
}

export type RefuseMember = (args: RefuseArgs) => string | null | undefined | Promise<string | null | undefined>

export type AuditEvent = {
  event: 'invite' | 'accept' | 'change-level' | 'remove'
  phase: 'before' | 'after'
  membership: ShareMember
  /** The membership as it was. Absent for an invitation. */
  previous?: ShareMember
  /** The signed-in user's id, or null for server code. */
  by: string | number | null
  req: PayloadRequest
}
export type AuditHook = (event: AuditEvent) => void | Promise<void>

type Check<A> = (args: A) => boolean | Promise<boolean>

export type SharingOptions = {
  /** Turn the plugin off without removing it. Default true. */
  enabled?: boolean
  /** The users collection. Default `users`. */
  users?: string
  /** Collections a member can come from. Default `[users]`. Add an organizations collection here. */
  memberTypes?: string[]
  /** The kinds of group the host offers, such as hobby, family or brand. With none, no group can be made. */
  kinds: { value: string; label?: string }[]
  /** Rename or relabel the three levels. The stored values default to `owner`, `manager` and `viewer`. */
  levels?: Partial<Record<Role, LevelConfig>>
  /**
   * Other identities the signed-in user acts as, such as the organizations they work for. A membership held by any of
   * them counts for the user. A throw means access is refused. Default: only the user.
   */
  identities?: (args: { req: PayloadRequest; user: User }) => MemberRef[] | Promise<MemberRef[]>
  /**
   * The people behind an organization, asked whenever an organization is invited, accepts or changes level, so that
   * `refuseMember` runs for each of them. Required when `memberTypes` adds anything beyond users and there is a veto;
   * pass `false` to say plainly that organizations are not checked person by person. Only the people listed at that
   * moment are checked: someone who joins the organization later is not, so the host must ask its veto again when people
   * join, or keep organizations out of groups where a veto matters.
   */
  peopleOf?: ((args: { req: PayloadRequest; organization: MemberRef }) => MemberRef[] | Promise<MemberRef[]>) | false
  /** Who may make a group. Only an exact `true` counts. The group's owner must also be the asker or one of their identities. */
  canCreateGroup?: Check<GroupArgs>
  /** Who may invite someone to a group. Only an exact `true` counts; a throw, a truthy value or no hook is a no. */
  canInvite?: Check<MemberArgs>
  /** Who may change a member's level. Same rule: only an exact `true`. */
  canChangeLevel?: Check<MemberArgs>
  /** Who may remove someone else. Default: whoever `canChangeLevel` allows. Anyone may always leave or decline for themselves. */
  canRemove?: Check<MemberArgs>
  /** Who may accept an invitation for an organization member. A user member can only be accepted by that user, never on their behalf. Default: nobody. */
  canAccept?: Check<MemberArgs>
  /**
   * Who may read memberships. Default: your own, every row in groups where you are an Owner or Manager, and only the
   * Owners and Managers of groups where you are a Viewer. May return a `where` to widen or narrow that.
   */
  canRead?: (args: { req: PayloadRequest; user: User }) => boolean | Where | Promise<boolean | Where>
  /**
   * A veto the host controls, asked on every invitation, acceptance and level change, even for server code that skips
   * access. Return `null` or nothing to go ahead, or a reason to refuse. A throw, `false` or anything else refuses with
   * a general reason. The reason is shown to whoever was refused, so never put a reason that reveals something private,
   * such as an age. Required: pass `false` to say plainly that the host has no veto.
   */
  refuseMember: RefuseMember | false
  /** Audit hooks. A `before` hook that throws stops the change. An `after` hook that throws is logged and ignored. */
  audit?: {
    beforeInvite?: AuditHook
    afterInvite?: AuditHook
    beforeAccept?: AuditHook
    afterAccept?: AuditHook
    beforeChangeLevel?: AuditHook
    afterChangeLevel?: AuditHook
    beforeRemove?: AuditHook
    afterRemove?: AuditHook
  }
  /** The admin group the collections sit in. Default `Sharing`. */
  adminGroup?: string
}

export type PayloadLike = Payload | { payload: Payload }
