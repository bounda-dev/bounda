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
  default, and the record of processing flags every field left in it.
- **Integrity and confidentiality, 5(1)(f).** Bounda: personal fields are encrypted at rest under
  a key per person and category, in events, process states, stored commands, dead letters and read
  models, and snapshots under the database's key, all under a [hierarchy of
  keys](/guides/personal-data/#three-keys-deep) no copy of the database opens on its own (see
  [article 32](#security-article-32)).
- **Accountability, 5(2).** Bounda: the [access log](/guides/personal-data/#who-opened-what)
  records every call that hands a person's data out in the clear, the event store records
  [who acted](/concepts/ids-causation-and-correlation/#who-acts) on every command, forgetting,
  restriction and redaction, and the [test helpers](/guides/personal-data/#in-tests),
  `expectForgotten`, `expectRedacted` and `expectRestricted`, prove in CI that a right was honoured
  everywhere the runtime keeps something. Left to the app: the policies, training and paperwork
  that make the rest of the accountability.

## Lawful basis and special data (articles 6 to 10)

**Article 6.** Every declared category names one of the six bases of article 6(1): `consent`,
`contract`, `legal-obligation`, `vital-interests`, `public-task` or `legitimate-interests`. A
category without one, or with another, does not compile, and the app refuses to start on it. The
basis decides what the runtime does: a `legal-obligation` category
[outlives a forgetting](/guides/personal-data/#categories) while its retention runs, and the
export's `rights` follow the bases. Bounda records the basis; whether it is the right one, and the
balancing test behind `legitimate-interests`, are the controller's. Article 6(4), whether a new
purpose is compatible with the one the data was collected for, is the controller's too.

**Article 7, consent.** Withdrawing consent is
[`forget(person, { categories })`](/guides/personal-data/#categories) on the categories processed
on `consent`: their keys go, their fields read as `null` everywhere, the rest of the person's data
stays, and the recipients that received them are told. `bounda forget <person> --category <name>`
does the same from a terminal, and the export lists the withdrawal among the person's `rights` for
those categories. Bounda keeps no record of consents given: to demonstrate a consent, as 7(1)
asks, the app records it as an event of its own, which carries its time and its
[actor](/concepts/ids-causation-and-correlation/#who-acts) like any other. The form, the wording,
and making withdrawal as easy as giving, 7(2) and 7(3), are the app's.

**Article 8, a child's consent.** Not covered: Bounda knows nothing of a person's age or of who
holds parental responsibility.

**Articles 9 and 10, special categories and criminal records.** Not covered. A category declares
a basis of article 6, never a condition of article 9(2), so neither the record of processing nor
the export says on which condition health, religious or biometric data is processed. Bounda only
helps find it: `bounda personal-data inventory` flags an unmarked field whose name points at a
special category or a criminal record, such as `health` or `religion`. Declaring such data its own
category, with its own retention, keeps it apart, so it can be forgotten or restricted on its own.

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
category, its retention, its sources (14(2)(f)), the recipients with their country and the
safeguard of a transfer, and the automated decisions with their logic. `bounda personal-data
inventory --json` prints all of it, for a notice to be written from or checked against. The
identity and contact details of the controller and of its data protection officer, the legitimate
interests pursued, and whether giving the data is a requirement of a contract or of the law are
not in the code, and the notice says them.

## Access (article 15)

**15(1) and 15(2).** [`exportPersonalData`](/guides/personal-data/#exporting-a-persons-data)
answers every item of article 15(1) from what the app declares, nothing written by hand beside it:

| Article 15 | In the export |
| --- | --- |
| confirmation that data is processed, and the data | every record that names the person, with the category of each field, and `held` per category |
| (a) the purposes | each category's `purposes`, with its `basis` |
| (b) the categories of data | `categories` |
| (c) the recipients, and 15(2) the safeguards of a transfer | `recipients`, as `recipientsOf` lists them |
| (d) how long it is kept | each category's `retention`, `keptUntil` and `restrictedUntil` |
| (e) rectification, erasure, restriction and objection | `rights` |
| (f) the complaint to a supervisory authority | `rights`, `complaint` |
| (g) the source of data not collected from the person | each category's `sources` |
| (h) automated decisions, profiling included | `automatedDecisions` |

It holds every event and read-model row that names the person, the scheduled commands and dead
letters that hold their data, the text of errors sealed under them, and the answers remembered
for their commands; restricted data comes out too, marked, since the right of access holds while a
restriction does. The [access log](/guides/personal-data/#who-opened-what) records each export
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

**15(4), the rights of others.** Left to the controller, and to know: the export opens what is
sealed under the person, and some text is sealed under several. The error text of a
[dead letter](/guides/dead-letters/#what-a-letter-holds) whose event names one person and whose
process state names another is sealed under both and comes out in the export of each; a rejection
remembered under an idempotency key is sealed under everyone whose data the state it was decided
on held, and comes out in the export of the person the command touched. Either may quote another
person's data. A free-text field, such as a note, may mention someone else too. Read those parts
before handing an export over where that matters.

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
once the key is gone, and appends `PersonalDataForgotten` to their stream. Read models' fields
[sealed at rest](/guides/personal-data/#sealed-at-rest) go with the key; a field [kept in the
clear](/guides/personal-data/#in-the-clear) forces its read model to project the forgetting, or the
app does not compile. Every [recipient](#notification-to-recipients-article-19) that received their
data is told, to erase it or, for what a legal obligation keeps, to restrict it. `forget(person, {
categories })` erases those categories alone, and `bounda forget <person>` does either from a
terminal. `expectForgotten` checks in a test that no value of theirs is left readable in any table,
log or span.

**Exceptions, 17(3)(b).** A category whose basis is `legal-obligation` outlives the forgetting
while its retention runs, restricted to the law that keeps it, and is forgotten when that ends. The
export's `rights` leave it out of erasure. The same point exempts a task carried out in the public
interest, but a category on `public-task` is not kept that way: `forget` erases it like any other
and the export lists erasure for it, so an app that must keep it leaves it out of the categories it
forgets. Other exceptions are the controller's to weigh, as for the controller's own legal claims
under 17(3)(e): it decides not to call `forget`, or which categories to name.

**Backups.** A restored copy brings back the keys of everyone forgotten after it was taken. A
[forget ledger](/guides/personal-data/#the-forget-ledger), kept outside the database, forgets them
again before the restored app serves anything, and the runtime [finds a
restore](/guides/personal-data/#restores) under a running app or, with a ledger, while it was
stopped. A backup that sits unrestored is put beyond use by
[retiring the tenant's older keys](/guides/personal-data/#old-backups) once it expires. See
[Backups and restores](/guides/backups/).

**A whole tenant.** [`forgetTenant`](/guides/personal-data/#forgetting-a-tenant) destroys the
tenant's key, so nothing sealed of it opens again in the database or any copy of it; what a copy
kept in the clear is in the [limitations](/reference/limitations/).

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
out, dead letters keep it sealed, and a disclosure to a recipient is refused. A call processes it
anyway only by [naming a basis of 18(2)](/guides/personal-data/#processing-restricted-data-anyway),
consent, legal claims, the protection of another's rights or public interest, which the access log
records. [`unrestrict`](/guides/personal-data/#lifting-a-restriction) takes a `notice`, and
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
declared late is presumed to hold what existed before, and told of the past.
[`recipientsOf(person)`](/guides/personal-data/#telling-the-person) and `bounda recipients <person>`
list a person's recipients, as 19 lets them ask.

Left to the app: what each handler does at the recipient, and whatever a port sends out without
declaring a recipient, which Bounda takes to be no personal data. Whether telling a recipient is
"impossible or involves disproportionate effort" is a judgement Bounda does not make: every
recipient that received the data is told.

## Portability (article 20)

The export is a structured, commonly used, machine-readable document, and its `rights` list
portability for the categories processed on `consent` or `contract`, as 20(1) has it. It holds
more than article 20 asks, what the app derived included; each category's `sources` say which data
came from the person. Left to the app: transmitting the data directly to another controller,
20(2), and leaving out what would affect the rights of others, 20(4).

## Objection (article 21)

The export's `rights` list objection for the categories processed on `public-task` or
`legitimate-interests`, as 21(1) has it, and `restrict(person, { ground: "objection-pending" })`
holds the processing while the objection is weighed (18(1)(d)). Once it is upheld, the app forgets
the categories concerned or stops the processing in its code. Weighing compelling legitimate
grounds is the controller's.

Direct marketing, 21(2) and 21(3), is not modelled: a category does not say its purpose is direct
marketing, so the export lists no objection to it for a category on `consent` or `contract`. On
`consent`, withdrawing it, which the export does list, has the same effect; otherwise the app tells
the person of the right itself, as 21(4) asks it to at the first communication at the latest, and
honours it in its code.

## Automated decisions (article 22)

`app/personal-data.ts` must export
[`automatedDecisions`](/guides/personal-data/#categories), `{}` for none: each decision made by
automated means alone with legal or similarly significant effects names its categories, its
`logic`, `significance` and `consequences` in words for the person, whether it profiles, and its
ground of 22(2), `contract`, `law` or `explicit-consent`. The app does not compile without it. The
export hands the person the decisions on categories they hold data of, with the right to human
intervention of 22(3) for those on `contract` or `explicit-consent`, and the record of processing
lists them all.

Left to the app: making the decisions, the human who reviews one, letting the person express their
view and contest it, the safeguards a law requires for those on `law`, and 22(4), which forbids
decisions on special categories but under conditions Bounda does not model. A decision made in
code and not declared is one Bounda cannot see.

## By design and by default (article 25)

Bounda's defaults are the protective ones: a field that can hold text does not compile until it is
[classified](/guides/personal-data/#fields-that-hold-no-personal-data); a personal field is sealed
under the person's key, and a read-model column too, unless it asks to be kept in the clear, which
then obliges its read model to project the forgetting; the runtime's logs and spans carry no error's
text unless [`errorText: "include"`](/reference/observability/#error-text) puts it there, which the
record of processing flags; every call that hands a person's data out in the clear is recorded, and
one whose record cannot be kept fails; an app with personal fields on a database that outlives the
process does not start without a master key and a tenant key store. What is necessary for each
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
each, deletes a customer's data at the end of the service, as 28(3)(g) asks, with
[`forgetTenant`](/guides/personal-data/#forgetting-a-tenant), in every copy of what was sealed.
Returning it is not
covered: there is no export of a whole tenant, only of each person in it, by an id the app knows.
The per-person calls are how it assists its controller with their requests, 28(3)(e).

Processing under the controller's authority, article 29, is the app's to enforce; the access log
names the [actor](/concepts/ids-causation-and-correlation/#who-acts) of every read, and the event
store the actor of every change.

## The record of processing activities (article 30)

[`bounda personal-data inventory`](/reference/cli/#bounda-personal-data-inventory) prints the
record from the app's modules and configuration, opening no database: the categories with their
basis, purposes, sources and retention; the automated decisions; every event, command, process
state and read model that holds personal data, whose, how it is kept and where its copies go; the
recipients, with their country and safeguard; what the runtime keeps about persons and for how
long; the keys and the forget ledger; and the fields marked `notPersonal`. `--markdown` writes it
as a document and `--json` as data; it exits `1` while anything keeps it from being complete, so a
CI step fails on it. See [The record of processing
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
  the app running.
- **Confidentiality, 32(1)(b).** The [access log](/guides/personal-data/#who-opened-what) records
  every call that hands a person's data out in the clear, and queries receive the actor, to read
  only what it may see. What it does not see, a column kept in the clear read around the client, is
  in the [limitations](/reference/limitations/#the-access-log).
- **Restoring availability, 32(1)(c).** [Backups and restores](/guides/backups/) has the steps for
  each engine, and the runtime forgets again, after a restore, whoever the copy brought back.
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
  whoever holds that version unable to open the persons' keys once the database's are rewrapped.

A leak of every level at once, the database, the tenant key store and the master key, exposes the
persons' keys themselves, and no rotation replaces those: rotating rewrites wrappings, never the
keys that seal the data.

Whether encryption made the data unintelligible to whoever took it, so that the person need not be
told under 34(3)(a), is the controller's assessment. Notifying the supervisory authority within 72
hours, 33(1), documenting the breach, 33(5), and telling the persons, 34, are the controller's.

## Impact assessment and data protection officer (articles 35 to 39)

Not covered. The record of processing is an input to a data protection impact assessment, article
35, and the prior consultation of article 36 is the controller's. So is designating a data
protection officer, articles 37 to 39.

## Transfers out of the EEA (articles 44 to 49)

A recipient declares its `country`, as an ISO 3166-1 alpha-2 code, and one outside the European
Economic Area its `safeguard`: `adequacy` (article 45), `standard-contractual-clauses` (46(2)(c)),
`binding-corporate-rules` (47), `code-of-conduct` or `certification` (46(2)(e) and (f)), or
`derogation` (49). The app does not start on a transfer without one. The export and
`recipientsOf` tell the person where their data went and on what it rests, 15(2), and the record of
processing lists every transfer.

On Cloudflare, `cloudflare({ jurisdiction: "eu" })` keeps every tenant's Durable Object, its
events, read models and keys, in the EU. Every way Bounda reaches an object follows it, an object
created elsewhere refuses to start, so no tenant has part of its data outside, and the record of
processing says where each holder is kept. `create-bounda` writes it. See
[Data location](/adapters/cloudflare/#data-location).

Left to the controller: the safeguard itself, the clauses signed and the transfer impact
assessment, and where the rest of the app's data lives. Bounda does not choose where a database
is: a PostgreSQL server, a SQLite file and their backups are where the app puts them. On
Cloudflare, the jurisdiction holds the objects, not the Worker that serves each request near it,
nor the tenant keys and the forget ledger in KV, wrapped keys and pseudonymous ids that KV keeps
wherever it does.

## Remedies (articles 77 to 82)

The export's `rights` always list the complaint to a supervisory authority, article 77. Which
authority, and the judicial remedies of articles 78 and 79, are the controller's to name, and
liability, article 82, the controller's to carry.
