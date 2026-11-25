---
title: GDPR rights in Bounda
description: The GDPR article by article, from the principles to the right to complain, each with what Bounda covers, the API, convention, command or guarantee and where it is explained, and what is left to the app and to the controller.
sidebar:
  order: 6
---

Bounda is a library: the controller is whoever runs the app, and most of what the GDPR asks of a
controller is decided, written and signed by people. What Bounda takes on is what the code and the
database can do, so that a request a person makes is one call, and what the app declares about
their data is the answer it gives them. This page goes through the regulation article by article
and says, for each, what Bounda does and what it leaves to the app and to the controller. It
describes the software; it is not legal advice.

Everything below rests on one rule, the limit to keep in mind for every article: Bounda knows the
personal data it is told about. A field of an event, a command, a process state or a read model is
personal data to Bounda once it is [marked](/guides/personal-data/#marking-a-field), and every field
that can hold text must be marked one way or the other before the app compiles. Data kept anywhere
else, in a port's own store, a log, a file, another service, is the app's to answer for.

## Principles (article 5)

- **Lawfulness, fairness and transparency, 5(1)(a).** Bounda: every
  [category](/guides/personal-data/#categories) of personal data declares its legal basis, its
  purposes and its sources in `app/personal-data.ts`, and the person's
  [export](/guides/personal-data/#exporting-a-persons-data) and the [record of processing
  activities](/guides/personal-data/#the-record-of-processing-activities) repeat them. Left to the
  app: whether the basis holds, and saying so to the person (see [articles 12 to
  14](#transparency-and-modalities-articles-12-to-14)).
- **Purpose limitation, 5(1)(b).** Bounda: each category names its purposes. It does not check
  that the code uses the data for them alone: a handler reads every field its event holds, whatever
  the purpose it serves. Left to the app.
- **Data minimisation, 5(1)(c).** Bounda: no field that can hold text compiles without a decision,
  `personal`, `person` or [`notPersonal`](/guides/personal-data/#fields-that-hold-no-personal-data),
  and `bounda personal-data inventory` flags an unmarked field whose name says personal data. What
  is necessary for a purpose is a judgement Bounda cannot make; the record lists every field for
  whoever makes it.
- **Accuracy, 5(1)(d).** Bounda: [`redact`](/guides/personal-data/#correcting-a-persons-data) seals
  a wrong value for good in the events that hold it, its copies and the recipients that received
  it (see [article 16](#rectification-article-16)).
- **Storage limitation, 5(1)(e).** Bounda: each category is
  [forgotten after its retention](/guides/personal-data/#each-category-for-its-own-time), counted
  from the person's last activity; `runtime.personalData.retention` forgets them as a whole after
  [inactivity](/guides/personal-data/#inactivity), and a process forgets them when a
  [purpose of the domain ends](/guides/personal-data/#end-of-purpose). A category declares its
  retention or the app does not compile; the default category's is the app's setting, which has no
  default, and the record of processing flags every field left in it. What the runtime keeps of
  its own work goes too: remembered answers after `runtime.commands.idempotencyKeyLifetime`, a
  subscriber's last failure once it is resolved, or its subscriber gone, for
  [`runtime.subscriberFailures.retention`](/reference/configuration/#subscriber-failures), 30 days
  by default, kept longer only while a person its text is sealed under is restricted, and resolved
  dead letters after [`runtime.deadLetters.retention`](/guides/dead-letters/#keeping-resolved-letters),
  30 days by default, kept longer only while a person whose data they hold is restricted; a
  `failed` letter stays until an operator settles it, since only they know whether the work it
  dropped is still owed, and `bounda status` counts those whose handler the app no longer runs, so
  none is kept unseen. The [forget ledger](/guides/personal-data/#the-forget-ledger), the one record
  of a forgotten person meant to outlive their data, is kept for its `keepFor`, and a [forgotten
  tenant's](/guides/personal-data/#forgetting-a-tenant) goes once every recipient of the tenant's
  data is told, when no copy of its database can need it any longer.
- **Integrity and confidentiality, 5(1)(f).** Bounda: personal fields are encrypted at rest under
  a key per person and category, in events, process states, stored commands, dead letters and read
  models, and snapshots under the database's key, all under a [hierarchy of
  keys](/guides/personal-data/#three-keys-deep) no copy of the database opens on its own (see
  [article 32](#security-article-32)).
- **Accountability, 5(2).** Bounda: the [access log](/guides/personal-data/#who-opened-what)
  records every call that hands a person's data out in the clear, and every call that asks for it
  and is refused before it reads, the [host log](/guides/personal-data/#refused-requests) every
  request refused before it reaches the app, the event store records
  [who acted](/concepts/ids-causation-and-correlation/#who-acts) on every command, forgetting,
  restriction and redaction, and the [test helpers](/guides/personal-data/#in-tests),
  `expectForgotten`, `expectRedacted` and `expectRestricted`, prove in CI that a right was honoured
  everywhere the runtime keeps something. Left to the app: the policies, training and paperwork
  that make the rest of the accountability.

## Lawful basis and special data (articles 6 to 10)

**Article 6.** Every declared category names one of the six bases of article 6(1): `consent`,
`contract`, `legal-obligation`, `vital-interests`, `public-task` or `legitimate-interests`. A
category without one, or with another, does not compile, and the app refuses to start on it. The
basis decides what the runtime does: a category on `legal-obligation` or `public-task`
[outlives a forgetting](/guides/personal-data/#categories) while its retention runs, one on
`consent` never does, and the export's `rights` follow the bases. Bounda records the basis; whether it is the right one, and the
balancing test behind `legitimate-interests`, are the controller's. Article 6(4), whether a new
purpose is compatible with the one the data was collected for, is the controller's too.

**Article 7, consent.** Withdrawing consent is
[`forget(person, { categories })`](/guides/personal-data/#categories) on the categories processed
on `consent`, or whose special data rests on `explicit-consent`: their keys go, their fields read as
`null` everywhere, the rest of the person's data stays, and the recipients that received them are
told. `bounda forget <person> --category <name>` does the same from a terminal, and the export
lists the withdrawal among the person's `rights` for those categories. Bounda keeps no record of
consents given: to demonstrate a consent, as 7(1) asks, the app records it as an event of its own,
which carries its time and its [actor](/concepts/ids-causation-and-correlation/#who-acts) like any
other. The form, the wording, and making withdrawal as easy as giving, 7(2) and 7(3), are the
app's.

**Article 8, a child's consent.** Not covered: Bounda knows nothing of a person's age or of who
holds parental responsibility.

**Article 9, special categories.** A category that holds data of article 9(1) says so with
[`special`](/guides/personal-data/#special-categories-and-criminal-data): which kinds it holds,
`racial-or-ethnic-origin`, `political-opinions`, `religious-or-philosophical-beliefs`,
`trade-union-membership`, `genetic`, `biometric`, `health` or `sex-life-or-sexual-orientation`, and
the condition of 9(2) it is processed on, besides its basis of article 6, which it still needs: one
of `explicit-consent` (a), `employment-and-social-protection` (b), `vital-interests` (c),
`not-for-profit-body` (d), `made-public` (e), `legal-claims` (f), `substantial-public-interest` (g),
`health-or-social-care` (h), `public-health` (i) or `archiving-research-or-statistics` (j). A
category that names special data without a condition, or a kind or condition Bounda does not know,
does not compile, and the app refuses to start on it. So does a category an exemption of 17(3)
keeps past a forgetting, as one on `legal-obligation` or `public-task`, whose special data rests on
`explicit-consent`: the exemption keeps the data past a forgetting, while a withdrawn consent leaves
no condition to keep it on. Special data on `archiving-research-or-statistics` names in
[`processedFor`](/guides/personal-data/#purposes-and-exemptions) the purpose of article 89(1) it
serves, archiving, research or statistics, which the objections of article 21 tell apart. The export and the record of processing state
each category's kinds and condition, and the export's `rights` follow the condition where the GDPR
makes them differ: data on `explicit-consent` can be withdrawn, 7(3), and is portable, 20(1)(a),
whatever the basis.

To find special data that was not declared, `bounda personal-data inventory` flags an unmarked
field whose name points at a special category or a criminal record, such as `health` or `religion`,
and a field marked personal whose name does, such as `allergies` or `politicalParty`, in a category
that does not declare it. Left to the controller: whether the condition is the right one; the law
that (b), (g), (h), (i) and (j) rest on, and the professional secrecy 9(3) asks of (h); keeping data
of a not-for-profit body (d) within it; and the further conditions a Member State sets for genetic,
biometric or health data, 9(4).

**Article 10, criminal convictions and offences.** A category that holds data relating to criminal
convictions and offences or related security measures says so with `criminal`, naming the
authority it is processed under: the control of an `official-authority`, or a `law` that provides
appropriate safeguards. The export and the record of processing state it. Which law, its safeguards,
and keeping a comprehensive register of criminal convictions only under official authority are the
controller's.

## Transparency and modalities (articles 12 to 14)

**Article 12.** Bounda: each request a person makes about their stored data is one call on every
[`BoundaClient`](/guides/personal-data/), the app, a Durable Object through `connect` and the
`bounda` context of React Router, and a command of the [CLI](/reference/cli/): access and
portability with `exportPersonalData` or `streamPersonalData`, rectification with `redact`,
erasure and the withdrawal of consent with `forget`, restriction with `restrict` and `unrestrict`,
and the recipients with `recipientsOf`. Left to the app:

- confirming who is asking, 12(6): every call takes a person's id, and the app authenticates the
  person before it passes one. `createWorker` on Cloudflare has no authentication of its own;
- the time limits of 12(3), one month extendable by two, and telling the person of a refusal and
  its reasons, 12(4): Bounda keeps no record of requests or deadlines;
- the charge, the refusal of a manifestly unfounded or excessive request, 12(5), and the form of
  the answer, 12(1): the export is a JSON document, and a page that shows it to the person in plain
  language is the app's.

**Articles 13 and 14, the information to give.** The privacy notice is the controller's. What the
app declares is most of what it has to say, and is in one place: the purposes and basis of each
category, with the condition of its special data or the authority of its criminal data, its
retention, its sources (14(2)(f)), the recipients with their country and the safeguard of a
transfer, and the automated decisions with their logic. `bounda personal-data inventory --json`
prints all of it, for a notice to be written from or checked against. The identity and contact
details of the controller and of its data protection officer, the legitimate interests pursued, and
whether giving the data is a requirement of a contract or of the law are not in the code, and the
notice says them.

## Access (article 15)

**15(1) and 15(2).** [`exportPersonalData`](/guides/personal-data/#exporting-a-persons-data)
answers every item of article 15(1) from what the app declares, nothing written by hand beside it:

| Article 15 | In the export |
| --- | --- |
| confirmation that data is processed, and the data | every record that names the person, with the category of each field, and `held` per category |
| (a) the purposes | each category's `purposes`, with its `basis` and, for special or criminal data, its `special` condition or `criminal` authority |
| (b) the categories of data | `categories`, with the special categories of data each holds |
| (c) the recipients, and 15(2) the safeguards of a transfer | `recipients`, as `recipientsOf` lists them, and `transfers`, the stores kept out of `storage`'s jurisdiction with their safeguard |
| (d) how long it is kept | each category's `retention`, `keptUntil` and `restrictedUntil` |
| (e) rectification, erasure, restriction and objection | `rights` |
| (f) the complaint to a supervisory authority | `rights`, `complaint` |
| (g) the source of data not collected from the person | each category's `sources` |
| (h) automated decisions, profiling included | `automatedDecisions`, with their `measures` on special categories of data |

It holds every event and read-model row that names the person, the scheduled commands and dead
letters that hold their data, the text of errors sealed under them, and the answers remembered
for their commands; restricted data comes out too, marked, since the right of access holds while a
restriction does, and what article 15(4) holds back is listed, marked, its value left out. The [access log](/guides/personal-data/#who-opened-what) records each export
before it hands anything out and again as it ends, so one cut short, or whose process died, is
recorded too.

**15(3), the copy.** The export is a JSON document. For a long history,
[`streamPersonalData`](/guides/personal-data/#a-long-history) hands it out a part at a time,
holding a page of records at most however much of it was redacted, and `personalDataExportJson`
writes the parts as the same document, as a stream of bytes. React Router answers it from a loader
with [`personalDataExportResponse`](/guides/react-router/#exporting-a-persons-data), uncached, and the
CLI with [`bounda personal-data
export`](/reference/cli/#bounda-personal-data-export-and-bounda-forget-person), to a file readable
by its owner alone. Charging for further copies is the app's.

**15(4), the rights of others.** The export hands each person what is theirs alone. A field marked
`personal` is the data of the person its event, state, command or row names, as the app declares
it. Text the app's code wrote, an error's or a remembered rejection's, may quote whatever the work
read, so Bounda seals it under everyone whose data the work read: the error text of a [dead
letter](/guides/dead-letters/#what-a-letter-holds) and of a subscriber's last failure under the
person its event names, the one its process state names, those whose aggregates the commands it
dispatched loaded, those whose rows a projection read and those a port's answer or a raw read
named; a remembered rejection under the person
the command touches and everyone whose data the state it was decided on held. A value sealed under
the person alone comes out; one sealed under someone else too reads `null`, and its record names
it in `withheld`, with `reason: "rights-of-others"` and `article: "15(4)"`, so the controller sees
what was held back and why. See [someone else's data](/guides/personal-data/#someone-elses-data).

Weighing the other person's rights against the person's is the controller's, and recital 63 asks
that it never end in refusing the person everything: `includeWithheld` opens the held-back values,
still marked, for the controller to read before deciding what to release, and the access log names
the other persons whose data they may quote. What a port returned, or a projection read through
`client.raw`, counts as read of whom the code names, in the port's `returnsPersonalData`, which
every port whose calls answer text must export, and with `client.rawReadOf`. What Bounda cannot
see stays the controller's to read before handing an export over: a field the app marked for one
person that holds another's, such as a note that names a friend, and a raw read the code does not
declare.

What the export cannot hold is what Bounda does not know of: a field left unmarked, a read model
without a field marked `.person()`, and whatever a port sent out. An app that owes the person more
adds it from its ports.

## Rectification (article 16)

Events are facts, so the correct value is a new event of the app's own, and
[`redact`](/guides/personal-data/#correcting-a-persons-data) seals the wrong one for good: in one
transaction it seals the named fields of the person's events under a key let go at once, so they
read `null` in every copy restored from then on, removes the snapshots and remembered rejections
that may quote them, cancels the scheduled commands that hold them and removes their dead letters,
seals for good the error text that quotes them, and appends `PersonalDataRedacted`. Read models
write over their copies, those that projected the events reached are rebuilt, and every recipient
that received data of a category redacted is told. `bounda redact <person> --from <file>` does it
from a terminal, and `expectRedacted` checks in a test that the old value is readable nowhere.

Left to the app: the command that records the corrected value, and completing incomplete data,
which is a command like any other.

## Erasure (article 17)

**What `forget` reaches.** [`forget(person)`](/guides/personal-data/#forgetting-a-person) deletes
the person's keys, so every field sealed under them reads `null` in every event however old, in the
live database and in every copy of it: crypto-shredding, since events are never deleted. In the same
transaction it cancels their scheduled commands, removes the dead letters of those, drops the
snapshots that held their data, erases the [answers
remembered](/guides/personal-data/#remembered-answers) that name them, which open in no copy either
once the key is gone, and appends `PersonalDataForgotten` to their stream. The error text of every
dead letter and subscriber failure whose work read their data is sealed under their keys too, so
it reads `null` from then on, the letter left for its retry. Read models' fields
[sealed at rest](/guides/personal-data/#sealed-at-rest) go with the key; a field [kept in the
clear](/guides/personal-data/#in-the-clear) forces its read model to project the forgetting, or the
app does not compile. Every [recipient](#notification-to-recipients-article-19) that received their
data is told, to erase it or, for what an exemption keeps, to restrict it. `forget(person, {
categories })` erases those categories alone, and `bounda forget <person>` does either from a
terminal. `expectForgotten` checks in a test that no value of theirs is left readable in any table,
log or span.

**Exceptions, 17(3).** A category an [exemption](/guides/personal-data/#categories) applies to
outlives the forgetting while its retention runs, restricted to what the exemption serves, and is
forgotten when that ends; the export's `rights` leave it out of erasure, and the export and the
record of processing name each category's exemptions, with their point, in `erasureExemptions`.
Bounda reads them from the declaration, as far as it shows that the processing is necessary:

- (b): a basis of `legal-obligation` or `public-task`. Point (b) names both in the words of 6(1)(c)
  and (e), and each of those bases already requires the processing to be necessary for the
  obligation or the task, so both are kept alike.
- (c): special data on `public-health`, 9(2)(i), whose condition is the public interest in the area
  of public health itself; and on `health-or-social-care`, 9(2)(h), only when the category claims
  `erasureExemption: "public-health"`, since care is not by itself processed for that interest.
- (d): a category processed for a purpose of article 89(1) that claims
  `erasureExemption: "archiving-research-or-statistics"`, since the point holds only where erasure
  would render impossible or seriously impair the objectives of the processing, which the
  controller judges.
- (e): special data on `legal-claims`, 9(2)(f), whose condition is the necessity for legal claims.

None applies on `consent`: withdrawing it leaves no basis to keep anything on, 17(1)(b), and
`erasureExemption` on it does not compile. Point (a), freedom of expression and information, is
the controller's under the law of its Member State, article 85; so are legal claims over data a
category does not hold for them, by not calling `forget`, or not naming the category. An
[upheld objection](#objection-article-21) keeps less, since 17(3) spares data from erasure and does
not allow processing what the person objected to.

**Backups.** A restored copy brings back the keys of everyone forgotten after it was taken. A
[forget ledger](/guides/personal-data/#the-forget-ledger), kept outside the database, forgets them
again before the restored app serves anything, and the runtime [finds a
restore](/guides/personal-data/#restores) under a running app or, with a ledger, while it was
stopped; a [strict](/guides/backups/#strict-reads) ledger hands out nothing read from a copy before
it is reconciled with it, and a read model in a database of its own restored from another moment
serves [nothing it should not](/guides/backups/#read-models-in-another-database). A backup that sits unrestored is put beyond use by
[retiring the tenant's older keys](/guides/personal-data/#old-backups) once it expires. See
[Backups and restores](/guides/backups/).

**A whole tenant.** [`forgetTenant`](/guides/personal-data/#forgetting-a-tenant) destroys the
tenant's key, so nothing sealed of it opens again in the database or any copy of it, and deletes
what an instance could still open with a key it keeps in memory, or that is kept in the clear and
nothing would end: snapshots, remembered answers, subscribers' last failures, dead letters but
those of the notices of the forgetting, and read models' rows. Once every recipient of the
tenant's data is told, the forget ledger's entries of the tenant go too, the ids of the persons it
forgot, restricted, redacted or disclosed: the tenant's key record refuses every copy of its
database from then on, and the only thing a copy restored before then still needed of the ledger
was whom to tell. The forgetting raises a fence in the database, every read model's database and
the ledger that no write of the tenant passes, from any instance, however long ago it last read
the tenant: nothing lands after the forgetting, nor after the ledger's clear, and a disclosure that
raced it either landed first, and its recipient is told, or never reached its port.
What a copy kept in the clear is in the [limitations](/reference/limitations/).

**Left to the app.** Deciding that a ground of 17(1) applies; what the app writes outside the
store, its logs among them; data in fields it did not mark; the [actor
ids](/concepts/ids-causation-and-correlation/#who-acts) in events' metadata, which stay; and,
under 17(2), telling other controllers to whom the app made the data public, which no port
declaration covers.

## Restriction (article 18)

[`restrict(person, { ground })`](/guides/personal-data/#restricting-processing) takes one of the
four grounds of 18(1), `accuracy-contested`, `unlawful-processing`, `legal-claims` or
`objection-pending`, for the person as a whole or for some categories. From then on, as 18(2)
asks, the data is kept and nothing else: commands that would touch it are refused with
`ProcessingRestrictedError`, policies and processes wait as dead letters, queries leave the rows
out, in the database itself for the SQL they run through `client.get` and `client.all` too, so
no page or count of theirs holds them, dead letters keep it sealed, a disclosure to a recipient is
refused, and the retention that
would forget the person, or remove a subscriber's last failure or a resolved dead letter that holds
their data, waits until the restriction is lifted, since keeping the data is what 18(1)(b) and (c)
ask; a failure or a letter whose text no longer opens, its person forgotten, holds nothing left to
keep and goes. A call processes it
anyway only by [naming a basis of 18(2)](/guides/personal-data/#processing-restricted-data-anyway),
consent, legal claims, the protection of another's rights or public interest, which the access log
records; what a forgetting kept under an exemption of 17(3) is restricted too, and opens only on
those or on `erasure-exemption`. `objection-pending` holds only what 18(1)(d) covers, an objection
under 21(1) while it is weighed: a category on `public-task` or `legitimate-interests` not
processed for direct marketing, which 21(3) leaves nothing to weigh, or the default category, which
declares no basis. Another category is refused, in the types and at runtime, and so is the person as
a whole while the app has one, since holding everything would restrict processing no objection
reaches. [`unrestrict`](/guides/personal-data/#lifting-a-restriction) takes a `notice`, and
announces the lift first with `ProcessingRestrictionLiftAnnounced`, so a policy tells the person
before it happens, as 18(3) asks; the reactions that waited run once it does. `bounda restrict`
and `bounda unrestrict` do the same from a terminal, and `expectRestricted` checks in a test that
what the app hands out holds nothing restricted.

Left to the app: deciding a ground applies, and the message that tells the person of the lift.

## Notification to recipients (article 19)

A port that sends personal data out declares its [recipient](/guides/personal-data/#recipients):
its name, its kind, its country and the categories it receives. Bounda records what each call
discloses to it, and tells it of every forgetting, restriction, announced lift, lift and
redaction that touches data it received, through handlers the port module must export, once at
least and in order, with a [dead letter](/guides/dead-letters/) when it keeps failing. A port
declared late is presumed to hold what existed before, and told of the past. A tenant's forgetting
tells every recipient of any of its persons' data, those of disclosures a restored copy of the
database lost included, which the forget ledger keeps until then; without a ledger to say which, a
copy restored before the forgetting tells every recipient the app declares, presumed to hold the
tenant's data. A port a start declared on a tenant frozen for its hand-back is told too, whichever
instance forgets it: the declaration waits in the tenant key store's record, which every instance
reads, until the thaw writes it.
[`recipientsOf(person)`](/guides/personal-data/#telling-the-person) and `bounda recipients <person>`
list a person's recipients, as 19 lets them ask.

Left to the app: what each handler does at the recipient, and whatever a port sends out without
declaring a recipient, which Bounda takes to be no personal data. Whether telling a recipient is
"impossible or involves disproportionate effort" is a judgement Bounda does not make: every
recipient that received the data is told.

## Portability (article 20)

The export is a structured, commonly used, machine-readable document, and its `rights` list
portability for the categories processed on `consent` or `contract`, or whose special data rests on
`explicit-consent`, as 20(1)(a) has it. It holds more than article 20 asks, what the app derived
included; each category's `sources` say which data came from the person. The rights of others,
20(4), are kept as 15(4) keeps them: the export holds back text that may quote someone else, marked
in `withheld`, and what Bounda cannot see is the controller's to read. Left to the app:
transmitting the data directly to another controller, 20(2).

## Objection (article 21)

A category says in [`processedFor`](/guides/personal-data/#purposes-and-exemptions) whether it is
processed for direct marketing, archiving in the public interest, scientific or historical
research, or statistics, and the export's `rights` list each objection from it and from the basis:

- **21(1)**, `objection`, for the categories on `public-task` or `legitimate-interests`.
  `restrict(person, { ground: "objection-pending" })` holds the processing while the objection is
  weighed (18(1)(d)); weighing compelling legitimate grounds is the controller's.
- **21(2) and (3)**, `objection-to-direct-marketing`, for the categories processed for
  `direct-marketing`, whatever the basis. Nothing is weighed: `forget(person, { categories })`
  erases them at once, `objection-pending` is refused for them, and a category for direct marketing
  that an exemption of 17(3) would keep past a forgetting does not compile, so no objection can
  leave it processed. Objecting forgets the whole category, so it holds what is processed for
  direct marketing alone.
- **21(6)**, `objection-to-research-or-statistics`, for the categories processed for
  `scientific-or-historical-research` or `statistics` on any basis but `public-task`, the one
  exception 21(6) makes being a task carried out for reasons of public interest. Archiving in the
  public interest has no objection of its own.

Once the app upholds an objection, it forgets with
[`objection: true`](/guides/personal-data/#after-an-objection), recorded with
`reason: "objection"`. An exemption of 17(3) spares data from erasure but does not allow processing
what the person objected to, which 21(1) stops but for legal claims: of a category an objection
reaches, only a legal obligation or legal claims keep anything, and what an earlier forgetting kept
of it under another exemption goes too. Whether an objection under 21(1) or 21(6) holds, the
derogations a Member State's law makes under article 89(2) and (3), telling the person of these
rights at the first communication at the latest, 21(4), and objecting by automated means in an
information society service, 21(5), are the app's.

## Automated decisions (article 22)

`app/personal-data.ts` must export
[`automatedDecisions`](/guides/personal-data/#categories), `{}` for none: each decision made by
automated means alone with legal or similarly significant effects names its categories, its
`logic`, `significance` and `consequences` in words for the person, whether it profiles, and its
ground of 22(2), `contract`, `law` or `explicit-consent`. The app does not compile without it. The
export hands the person the decisions on categories they hold data of, with the right to human
intervention of 22(3) for those on `contract` or `explicit-consent`, and the record of processing
lists them all.

**22(4), special categories.** A decision on a category that declares
[special data](/guides/personal-data/#special-categories-and-criminal-data) is allowed only when that
category's condition is `explicit-consent` (9(2)(a)) or `substantial-public-interest` (9(2)(g)), and
must say its `measures`, the suitable measures that safeguard the person, in words for them. Any
other condition, or no measures, does not compile, and the app refuses to start on it. The export
hands the person the measures with the decision, and the record of processing lists, for each
decision, the special data it decides on and its measures. A decision on any other category may say
its measures too, those of 22(3).

Left to the app: making the decisions, the human who reviews one, letting the person express their
view and contest it, the safeguards a law requires for those on `law`, and putting the measures it
declares in place. A decision made in code and not declared is one Bounda cannot see.

## By design and by default (article 25)

Bounda's defaults are the protective ones: a field that can hold text does not compile until it is
[classified](/guides/personal-data/#fields-that-hold-no-personal-data); a personal field is sealed
under the person's key, and a read-model column too, unless it asks to be kept in the clear, which
then obliges its read model to project the forgetting; the runtime's logs and spans carry no error's
text unless [`errorText: "include"`](/reference/observability/#error-text) puts it there, which the
record of processing flags; every call that hands a person's data out in the clear is recorded, and
one whose record cannot be kept fails; what the runtime keeps of its own work, remembered answers,
subscribers' last failures and resolved dead letters, is removed after a retention that has a
default; an app with personal fields on a database that outlives the process does not start without
a master key and a tenant key store. What is necessary for each
purpose, and so what is collected at all, stays the controller's design.

## Controllers and processors (articles 26 to 29)

A recipient's `kind` is a `processor` (article 28), a `joint-controller` (article 26) or a
`third-party`, and the record of processing lists it. The contracts themselves, the processing
agreement of 28(3) and the arrangement of 26, are the controller's, as is naming a representative
in the Union, article 27, which the record leaves to fill in.

The providers the app runs on, its database host or Cloudflare, are processors too, and no port
declares them: the record of processing lists the databases each kind of data is kept in, by
adapter, not who hosts them.

An app that is itself a processor for its customers, one [tenant](/guides/personal-data/#tenants)
each, deletes or returns a customer's data at the end of the service, as 28(3)(g) asks and as the
customer chooses: [`exportTenant`](/guides/personal-data/#handing-a-tenant-back) returns it, every
person, recipient of their data, event, scheduled command, dead letter, subscriber failure,
remembered answer, read-model row and forget ledger entry, every value opened and nothing held
back, with the stores kept in another jurisdiction and, for each recipient, its country and the
safeguard of a transfer, so the controller knows where the data went and on what each transfer
rested, as JSON Lines that
`readTenantExport` checks are whole, of a tenant [frozen](/guides/personal-data/#freezing-a-tenant)
in every store, so what it returns is one consistent cut that no write changed while it was read; [`forgetTenant`](/guides/personal-data/#forgetting-a-tenant)
then deletes it, in every copy of what was sealed. The export is recorded in the access log. The
per-person calls are how it assists its controller with their requests, 28(3)(e).

Processing under the controller's authority, article 29, is the app's to enforce; the access log
names the [actor](/concepts/ids-causation-and-correlation/#who-acts) of every read, and the event
store the actor of every change.

## The record of processing activities (article 30)

[`bounda personal-data inventory`](/reference/cli/#bounda-personal-data-inventory) prints the record
from the app's modules and configuration, opening no database: the categories with their basis, the
special categories of data and the criminal data they hold, with their condition or authority, their
purposes and those the GDPR has rules for, their sources and retention, and the exemptions of 17(3)
that keep them past erasure; the automated decisions; every event, command, process state and
read model that holds personal data, whose, how it is kept and where its copies go; the recipients,
with their country and safeguard; what the runtime keeps about persons and for how long, the dead
letters, the subscribers' last failures and the remembered answers among it, with what an export
holds back of them under 15(4); the keys,
the master key, the tenant key store and the forget ledger; where each database and store keeps them, as its
`location` declares it, and the safeguard of each one kept out of `storage`'s, so the record names
every transfer to a third country, 30(1)(e);
and the fields marked `notPersonal`. `--markdown` writes it as a document and
`--json` as data; it exits `1` while anything keeps it from being complete, a store of personal data that
declares no location among it, so a CI step fails on it. See [The record of processing
activities](/guides/personal-data/#the-record-of-processing-activities).

Left to the controller: its name and contact details, those of its representative and its data
protection officer, the categories of persons each id stands for, and the security measures
outside the app. The record is a controller's, 30(1); the record a processor keeps, 30(2), is
organised by the controllers it serves, which Bounda does not know.

## Security (article 32)

- **Encryption, 32(1)(a).** Every personal field is sealed with AES-256-GCM through WebCrypto
  under a key per person and category. The keys are wrapped under the tenant's key, kept in a
  [tenant key store](/guides/personal-data/#the-tenant-key-store) apart from the database, and that
  key under a [master key](/guides/personal-data/#a-master-key) kept in the environment or a
  [KMS](/guides/personal-data/#a-kms-or-a-vault), with AES-KW, so a copy of the database opens
  nothing without the other two. Read-model columns are sealed too, found by [blind
  indexes](/guides/personal-data/#sealed-at-rest), and a SQLite file is [encrypted
  whole](/guides/personal-data/#encrypted-database-files) under the tenant's key.
  The master key and the tenant's key [rotate](/guides/personal-data/#rotating-the-master-key) with
  the app running, and after a leak of all three every key that seals the data is
  [replaced](/guides/personal-data/#recovering-from-a-full-compromise) and the data sealed again.
- **Confidentiality, 32(1)(b).** The [access log](/guides/personal-data/#who-opened-what) records
  every call that hands a person's data out in the clear, and queries receive the actor, to read
  only what it may see; the [host log](/guides/personal-data/#refused-requests) records every
  request refused before it reached the app, for its route, its body, its tenant or who made it.
  What they do not see, a column kept in the clear read around the client, is in the
  [limitations](/reference/limitations/#the-access-log).
- **Restoring availability, 32(1)(c).** [Backups and restores](/guides/backups/) has the steps for
  each engine, `bounda restore` puts a SQLite copy back under a running app in one transaction, and
  the runtime forgets again, after a restore, whoever the copy brought back, before a read model
  restored from another moment than the stream serves anything.
- **Testing, 32(1)(d).** `expectForgotten`, `expectRedacted`, `expectRestricted` and
  `expectTenantForgotten` run in any test runner, on a test app or, through
  [`createWitness`](/guides/personal-data/#an-app-built-otherwise), on the app as it boots.

Left to the app: authentication and authorisation, the network, the hosts, the secrets kept where
the master key is, who may read the access log, and what a field kept in the clear exposes. What
is not marked is stored as it comes; the [limitations](/reference/limitations/) say what a copy of
the database keeps readable.

## Breaches (articles 33 and 34)

Bounda detects no breach and notifies no one. What it gives the controller once one is found:

- what was readable: a copy of the database alone holds the personal fields as ciphertext that
  opens nothing without the tenant key store and the master key, while ids, fields not marked and
  columns kept in the clear are readable, and the record of processing says which those are;
- whose data was opened through the app, in the access log;
- whom to tell downstream, with `recipientsOf`;
- the way out of a leaked key: [rotating the master
  key](/guides/personal-data/#rotating-the-master-key) leaves whoever holds the old one unable to
  open the tenant key store once its records are rewrapped, and [rotating the tenant's
  key](/guides/personal-data/#rotating-the-tenants-key) and retiring the older version leaves
  whoever holds that version unable to open the persons' keys once the database's are rewrapped;
- the way out of a leak of every level at once, the database, the tenant key store and the master
  key, which exposes the persons' keys themselves: [a
  reseal](/guides/personal-data/#recovering-from-a-full-compromise) replaces every person's key and
  the database's key, with the app running, seals again under the new keys everything the store
  holds of persons and rebuilds the read models, then destroys the old keys. What was taken stays
  readable to whoever took it, and so does a backup taken before; nothing written or kept after the
  reseal opens with the keys taken, a person forgotten or a value redacted before it included.

Whether encryption made the data unintelligible to whoever took it, so that the person need not be
told under 34(3)(a), is the controller's assessment. Notifying the supervisory authority within 72
hours, 33(1), documenting the breach, 33(5), and telling the persons, 34, are the controller's.

## Impact assessment and data protection officer (articles 35 to 39)

Not covered. The record of processing is an input to a data protection impact assessment, article
35, and names the categories of special or criminal data, whose processing on a large scale calls
for one, 35(3)(b), and for a data protection officer when it is the controller's core activity,
37(1)(c). The assessment, the prior consultation of article 36 and designating the officer, articles
37 to 39, are the controller's.

## Transfers out of the EEA (articles 44 to 49)

A recipient declares its `country`, as an ISO 3166-1 alpha-2 code, and one outside the European
Economic Area its `safeguard`: `adequacy` (article 45), `standard-contractual-clauses` (46(2)(c)),
`binding-corporate-rules` (47), `code-of-conduct` or `certification` (46(2)(e) and (f)), or
`derogation` (49). The app does not start on a transfer without one. The export and
`recipientsOf` tell the person where their data went and on what it rests, with the article, 15(2),
and the record of processing lists every transfer. A tenant's export sums the recipients of every
person in it, once under each identity a disclosure was recorded with, for the controller it is
handed back to, 28(3)(g).

Every database and store declares the jurisdiction it keeps its data in: `location: "eu"` on
`sqlite()`, `postgresql()` and `memory()`, the `jurisdiction` on `cloudflare()`, and the `location`
of `defineTenantKeyStore` and `defineForgetLedger` for stores of your own; `masterKey` and
`defineKeyWrapper` declare where the master key is. The location `storage` declares is the app's:
the app refuses to start, and the record of processing to be drawn, on a read model, tenant key
store, forget ledger or key wrapper that declares none, or another without a `safeguard`, since
each carries the persons' data, or the key that opens it, wherever it is kept, and encryption
protects data from a transfer only while its keys stay where the data is (EDPB recommendations
01/2020). A store kept elsewhere declares its safeguard as a recipient does, one of articles 45 to
47; a `derogation` of article 49 covers occasional transfers alone (EDPB guidelines 2/2018), never a
store that keeps data for as long as the app runs, and is refused, as is a safeguard on a store kept
where `storage` is. The record of processing states each one's location and the safeguard of each
transfer, 30(1)(e), and lists every store of personal data, and the key wrapper, that declares no
location as a finding; each person's export lists the transfers in `transfers`, 15(2), and so does
the header of a tenant's export, 28(3)(g).
`create-bounda` writes `"eu"` in every project. See [Data
location](/reference/configuration/#data-location).

On Cloudflare, `cloudflare({ jurisdiction: "eu" })` keeps every tenant's Durable Object, its
events, read models and keys, in the EU, and the keeper objects that hold each tenant's key and
forget ledger with them, unless `durableObjectTenantKeys` or `durableObjectForgetLedger` names
another `jurisdiction` with a `safeguard`. Every way Bounda reaches an object follows it, an object
or a keeper created elsewhere refuses to start, so no tenant has part of its data outside where it
is declared. A tenant key store or forget ledger in Workers KV, whose pairs Cloudflare does not hold
to a jurisdiction, declares none, and is refused under one, unless it declares where it may keep
them, never that jurisdiction, with a safeguard. See [Data location](/adapters/cloudflare/#data-location).

Left to the controller: the safeguard itself, the clauses signed and the transfer impact
assessment, and the truth of every `location` but the one Cloudflare holds an object to. Bounda
cannot see where a PostgreSQL server, a SQLite file or a process runs, so a declared location is
taken at its word, and the processes of a Node app must run where its storage is. Backups, logs and
the access log `app/audit.ts` are where the app puts them; on Cloudflare, an object checks its
own jurisdiction, but Bounda cannot see where a Worker's secrets are kept, so the master key's
location is the controller's to keep true. Locations are compared as written: two names are two
jurisdictions, even both in one country. On Cloudflare, the jurisdiction holds the objects, not the
Worker that serves each request near it.

## Remedies (articles 77 to 82)

The export's `rights` always list the complaint to a supervisory authority, article 77. Which
authority, and the judicial remedies of articles 78 and 79, are the controller's to name, and
liability, article 82, the controller's to carry.
