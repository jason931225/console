//! CI gate: personal-data classification completeness.
//!
//! WHAT THIS ENFORCES. Every column created by a migration, in a table that is
//! NOT listed in the baseline, must carry a
//! `COMMENT ON COLUMN <table>.<column> IS 'pd:<tokens> …'` marker whose tokens
//! all come from a closed vocabulary. The baseline is the declared,
//! shrink-only backlog of tables nobody has classified yet; a NEW table is
//! never in it, so a new table must be fully classified at creation. That one
//! property is the completeness enforcement — everything else is debt
//! burn-down.
//!
//! WHAT THIS DOES NOT DO, stated here because a gate whose scope is guessed at
//! is worse than none. It asserts nothing about whether any statutory
//! obligation is met, and moves no compliance control out of HOLD. A
//! classification is an INPUT to that question. Deciding that a given column is
//! 민감정보 under 개인정보 보호법 제23조제1항 is a legal judgement made by a
//! human and recorded in the migration; this gate only checks that the
//! judgement was recorded, is spelled from the closed vocabulary, and points at
//! a column that exists.
//!
//! WHY `COMMENT ON COLUMN` AND NOT A REGISTRY TABLE OR A MANIFEST. Drift has
//! two directions and both must be mechanical, not "discouraged":
//!
//! * classification points at a column that does not exist — Postgres closes
//!   this itself. `COMMENT ON COLUMN foo.bar` where `bar` is absent raises
//!   `ERROR: column "bar" of relation "foo" does not exist` and the migration
//!   aborts. No registry table can have a foreign key into `pg_attribute`, so
//!   a stale registry row is silent forever. This gate re-checks the same
//!   condition as defence in depth.
//! * column exists, classification absent — that is this gate.
//!
//! The known weakness, named rather than hidden: `ALTER TABLE ... DROP COLUMN`
//! silently discards the column's comment, so a drop-and-recreate loses the
//! classification. That case lands as a column present in the parsed schema
//! with no marker, which is exactly what this gate rejects. The gate is not
//! decoration around the Postgres error; it is the other half of the mechanism.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

/// Baseline path relative to the workspace root.
pub const BASELINE_RELATIVE_PATH: &str =
    "backend/ci/gates/personal-data-classification/unclassified-tables.txt";

/// Prefix that marks a column comment as a personal-data classification.
pub const MARKER_PREFIX: &str = "pd:";

// ---------------------------------------------------------------------------
// Closed vocabulary, each token carrying the instrument it rests on.
// ---------------------------------------------------------------------------

/// One classification token and the instrument that creates the distinction.
///
/// The citation lives here, in executable code, rather than only in prose, so
/// that a rejection message names the instrument a author must read. `verified`
/// is the 시행일자 of the version checked against the official legislation
/// portal (law.go.kr) on 2026-08-01.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClassCitation {
    /// Vocabulary token, e.g. `unique-id`.
    pub token: &'static str,
    /// Instrument name and version.
    pub instrument: &'static str,
    /// Article the classification rests on.
    pub article: &'static str,
    /// 시행일자 of the version verified.
    pub effective: &'static str,
    /// Sub-tokens this class requires, empty when the class takes none.
    pub subtokens: &'static [&'static str],
}

/// 고유식별정보 — 개인정보 보호법 시행령 제19조 is a CLOSED set of exactly four,
/// each pinned to its own defining Act. That is why this is an enum and not an
/// open category, and why a column claiming membership must name which of the
/// four: 고시 제2026-9호 제7조제3항제2호 makes 주민등록번호 unconditional while
/// the other three may be scoped by a documented 위험도 분석, so `rrn` is
/// legally distinct from its three siblings and a bare `unique-id` would erase
/// that distinction.
const UNIQUE_ID_SUBTOKENS: &[&str] = &[
    // 「주민등록법」 제7조의2제1항에 따른 주민등록번호
    "rrn",
    // 「여권법」 제7조제1항제1호에 따른 여권번호
    "passport",
    // 「도로교통법」 제80조에 따른 운전면허의 면허번호
    "driver-license",
    // 「출입국관리법」 제31조제5항에 따른 외국인등록번호
    "arc",
];

/// 민감정보 — unlike 고유식별정보 this list is NOT closed. 개인정보 보호법
/// 제23조제1항 says `사상ㆍ신념 … 성생활 등에 관한 정보` and then adds a
/// 사생활 현저 침해 catch-all, so assigning a column to this class is a legal
/// judgement. Encoding the sub-category makes each judgement auditable per
/// column instead of hiding nine different decisions behind one boolean.
const SENSITIVE_SUBTOKENS: &[&str] = &[
    // 제23조제1항 본문
    "belief",
    "union",
    "political",
    "health",
    "sex-life",
    // 시행령 제18조
    "genetic",
    "criminal-record",
    "biometric-id",
    "race-ethnicity",
];

/// The closed vocabulary. Order is the order the gate prints them in.
pub const VOCABULARY: &[ClassCitation] = &[
    ClassCitation {
        token: "none",
        instrument: "— (no instrument: asserts no personal data is held)",
        article: "—",
        effective: "—",
        subtokens: &[],
    },
    ClassCitation {
        token: "personal",
        instrument: "개인정보 보호법 (법률 제20897호)",
        article: "제2조제1호 (정의), 제21조제1항 (파기: 지체 없이)",
        effective: "2025-10-02 (제21조 unchanged by 법률 제21445호, 시행 2026-09-11)",
        subtokens: &[],
    },
    ClassCitation {
        token: "sensitive",
        instrument: "개인정보 보호법 + 시행령 (대통령령 제36121호)",
        article: "법 제23조제1항, 영 제18조",
        effective: "영 2026-08-20 (영 제18조 개정 2020.8.4; 법 제23조제1항 unchanged)",
        subtokens: SENSITIVE_SUBTOKENS,
    },
    ClassCitation {
        token: "unique-id",
        instrument: "개인정보 보호법 + 시행령 (대통령령 제36121호)",
        article: "법 제24조제1항, 영 제19조",
        effective: "영 2026-08-20 (법 제24조제3항 reworded to 「유출등」 on 2026-09-11; scope unchanged)",
        subtokens: UNIQUE_ID_SUBTOKENS,
    },
    ClassCitation {
        token: "credit",
        instrument: "신용정보의 이용 및 보호에 관한 법률 (법률 제21646호)",
        article: "제2조제2호, 제20조의2제2항 (개보법 제21조제1항을 명시적으로 배제)",
        effective: "2026-08-13 (제20조의2 본조신설 2015.3.11, 개정 2020.2.4 — 현행)",
        subtokens: &[],
    },
    ClassCitation {
        token: "pseudonymous",
        instrument: "개인정보 보호법 (법률 제21445호)",
        article: "제28조의2, 제28조의4제2항ㆍ제3항, 제28조의7 (적용 제외)",
        effective: "2026-09-11 (제28조의7이 제34조제2항까지 적용 제외로 확대)",
        subtokens: &[],
    },
    ClassCitation {
        token: "undeclared",
        instrument: "— (no instrument: an admission, not a classification)",
        article: "—",
        effective: "—",
        subtokens: &[],
    },
];

/// Look a token up in the closed vocabulary.
#[must_use]
pub fn citation_for(token: &str) -> Option<&'static ClassCitation> {
    VOCABULARY.iter().find(|entry| entry.token == token)
}

// ---------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------

/// The distinct ways classification can be wrong or absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViolationKind {
    /// A column in a non-baselined table carries no `pd:` marker.
    UnclassifiedColumn,
    /// A marker token is outside the closed vocabulary.
    UnknownToken,
    /// `unique-id` or `sensitive` used without its required sub-token, or with
    /// a sub-token outside that class's list.
    BadSubtoken,
    /// A marker names a table or column the migration parse says does not exist.
    MarkerForUnknownColumn,
    /// A marker string starts with `pd:` but carries no tokens at all.
    EmptyMarker,
    /// Two markers classify the same column.
    DuplicateMarker,
    /// A baselined table is now fully classified: the baseline must shrink.
    BaselineEntryFullyClassified,
    /// A baseline entry names a table that no longer exists.
    BaselineEntryUnknownTable,
}

impl ViolationKind {
    #[must_use]
    fn label(self) -> &'static str {
        match self {
            Self::UnclassifiedColumn => "unclassified-column",
            Self::UnknownToken => "unknown-token",
            Self::BadSubtoken => "bad-subtoken",
            Self::MarkerForUnknownColumn => "marker-for-unknown-column",
            Self::EmptyMarker => "empty-marker",
            Self::DuplicateMarker => "duplicate-marker",
            Self::BaselineEntryFullyClassified => "baseline-entry-fully-classified",
            Self::BaselineEntryUnknownTable => "baseline-entry-unknown-table",
        }
    }
}

/// A single gate finding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    /// Which rule was broken.
    pub kind: ViolationKind,
    /// Migration file the finding is anchored to, when there is one.
    pub file: Option<PathBuf>,
    /// Human-readable detail.
    pub detail: String,
}

impl fmt::Display for Violation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.file {
            Some(path) => write!(
                f,
                "[{}] {}: {}",
                self.kind.label(),
                path.display(),
                self.detail
            ),
            None => write!(f, "[{}] {}", self.kind.label(), self.detail),
        }
    }
}

/// Outcome of one gate run.
#[derive(Debug, Default)]
pub struct GateResult {
    /// Findings, empty when the gate passes.
    pub violations: Vec<Violation>,
    /// Columns carrying a well-formed marker.
    pub classified_columns: usize,
    /// Columns in the parsed post-migration schema.
    pub total_columns: usize,
    /// Tables in the parsed post-migration schema.
    pub total_tables: usize,
    /// Tables still listed in the baseline.
    pub baselined_tables: usize,
}

impl GateResult {
    /// True when nothing was found.
    #[must_use]
    pub fn passed(&self) -> bool {
        self.violations.is_empty()
    }

    fn push(&mut self, kind: ViolationKind, file: Option<PathBuf>, detail: String) {
        self.violations.push(Violation { kind, file, detail });
    }
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------
//
// One lexer feeds both halves of the gate — the DDL parse that yields the
// column set, and the marker scan that yields the classification set. Two
// separate scanners would be free to disagree about what a string literal or a
// dollar-quoted plpgsql body is, and a gate whose two halves disagree reports
// drift that is its own.

#[derive(Debug, Clone, PartialEq, Eq)]
enum Tok {
    /// Identifier or number, lowercased.
    Word(String),
    /// Single-quoted string body, case preserved.
    Str(String),
    /// Any other single character.
    Punct(char),
}

impl Tok {
    fn word(&self) -> Option<&str> {
        match self {
            Self::Word(w) => Some(w.as_str()),
            _ => None,
        }
    }

    fn is_punct(&self, ch: char) -> bool {
        matches!(self, Self::Punct(c) if *c == ch)
    }
}

/// Lex SQL into words, string literals and punctuation.
///
/// Comments are dropped. Dollar-quoted bodies are dropped entirely and replaced
/// by an empty string token: they hold plpgsql, and this repo's plpgsql builds
/// DDL with `EXECUTE format('DROP TABLE …')` (0005 does exactly that for
/// `location_pings` day partitions). Lexing into those bodies would invent
/// tables and drop real ones.
fn lex(sql: &str) -> Vec<Tok> {
    let bytes = sql.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0usize;

    while i < bytes.len() {
        let b = bytes[i];
        let next = bytes.get(i + 1).copied();

        // -- line comment
        if b == b'-' && next == Some(b'-') {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // /* block comment */, nestable per the SQL standard and per Postgres.
        if b == b'/' && next == Some(b'*') {
            let mut depth = 1usize;
            i += 2;
            while i < bytes.len() && depth > 0 {
                if bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*') {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        // $tag$ … $tag$
        if b == b'$'
            && let Some(tag_end) = dollar_tag_end(bytes, i)
        {
            let tag = &sql[i..tag_end];
            let body_start = tag_end;
            match sql[body_start..].find(tag) {
                Some(offset) => i = body_start + offset + tag.len(),
                None => i = bytes.len(),
            }
            tokens.push(Tok::Str(String::new()));
            continue;
        }
        // 'string', with '' as the embedded quote.
        if b == b'\'' {
            let mut body = String::new();
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\'' {
                    if bytes.get(i + 1) == Some(&b'\'') {
                        body.push('\'');
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                let ch_start = i;
                let mut ch_end = i + 1;
                while ch_end < bytes.len() && (bytes[ch_end] & 0xC0) == 0x80 {
                    ch_end += 1;
                }
                body.push_str(&sql[ch_start..ch_end]);
                i = ch_end;
            }
            tokens.push(Tok::Str(body));
            continue;
        }
        // "quoted identifier"
        if b == b'"' {
            let mut body = String::new();
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'"' {
                    if bytes.get(i + 1) == Some(&b'"') {
                        body.push('"');
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                body.push(bytes[i] as char);
                i += 1;
            }
            tokens.push(Tok::Word(body.to_ascii_lowercase()));
            continue;
        }
        if b.is_ascii_alphanumeric() || b == b'_' {
            let start = i;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'$')
            {
                i += 1;
            }
            tokens.push(Tok::Word(sql[start..i].to_ascii_lowercase()));
            continue;
        }
        if b.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        tokens.push(Tok::Punct(b as char));
        i += 1;
    }

    tokens
}

/// If a `$` at `start` opens a dollar quote, return the index just past its tag.
fn dollar_tag_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 1;
    while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
        i += 1;
    }
    if bytes.get(i) == Some(&b'$') {
        Some(i + 1)
    } else {
        None
    }
}

/// Split a token stream into statements on top-level `;`.
fn statements(tokens: &[Tok]) -> Vec<&[Tok]> {
    let mut out = Vec::new();
    let mut start = 0usize;
    for (index, token) in tokens.iter().enumerate() {
        if token.is_punct(';') {
            if index > start {
                out.push(&tokens[start..index]);
            }
            start = index + 1;
        }
    }
    if start < tokens.len() {
        out.push(&tokens[start..]);
    }
    out
}

// ---------------------------------------------------------------------------
// Schema parse
// ---------------------------------------------------------------------------

/// The post-migration column set, plus where each column was introduced.
#[derive(Debug, Default)]
pub struct Schema {
    /// table -> ordered column names.
    pub tables: BTreeMap<String, BTreeSet<String>>,
    /// (table, column) -> migration file that introduced it.
    pub origins: BTreeMap<(String, String), PathBuf>,
}

impl Schema {
    /// Total columns across all tables.
    #[must_use]
    pub fn column_count(&self) -> usize {
        self.tables.values().map(BTreeSet::len).sum()
    }
}

/// Words that begin a table-level constraint rather than a column definition.
const CONSTRAINT_HEADS: &[&str] = &[
    "constraint",
    "primary",
    "unique",
    "foreign",
    "check",
    "exclude",
    "like",
    "partition",
];

/// Parse `CREATE TABLE`, `ALTER TABLE … ADD/DROP COLUMN` and `DROP TABLE`
/// across every migration file, in filename order, into a post-migration schema.
#[must_use]
pub fn parse_schema(files: &[PathBuf]) -> Schema {
    let mut schema = Schema::default();
    for file in files {
        let Ok(content) = fs::read_to_string(file) else {
            continue;
        };
        let tokens = lex(&content);
        for statement in statements(&tokens) {
            apply_statement(statement, file, &mut schema);
        }
    }
    schema
}

fn apply_statement(statement: &[Tok], file: &Path, schema: &mut Schema) {
    let head: Vec<&str> = statement.iter().take(4).filter_map(Tok::word).collect();
    match head.first().copied() {
        Some("create") if head.get(1).copied() == Some("table") => {
            apply_create_table(statement, file, schema);
        }
        Some("drop") if head.get(1).copied() == Some("table") => {
            for table in drop_table_targets(statement) {
                schema.tables.remove(&table);
                schema.origins.retain(|(t, _), _| t != &table);
            }
        }
        Some("alter") if head.get(1).copied() == Some("table") => {
            apply_alter_table(statement, file, schema);
        }
        _ => {}
    }
}

/// Consume `[IF NOT EXISTS]` / `[IF EXISTS]` and return the index of the name.
fn skip_if_clause(statement: &[Tok], mut index: usize) -> usize {
    while let Some(word) = statement.get(index).and_then(Tok::word) {
        if matches!(word, "if" | "not" | "exists" | "only") {
            index += 1;
        } else {
            break;
        }
    }
    index
}

/// Read a possibly schema-qualified name and return `(name, next_index)`.
fn read_qualified_name(statement: &[Tok], index: usize) -> Option<(String, usize)> {
    let mut name = statement.get(index)?.word()?.to_owned();
    let mut cursor = index + 1;
    while statement.get(cursor).is_some_and(|t| t.is_punct('.')) {
        if let Some(part) = statement.get(cursor + 1).and_then(Tok::word) {
            name = part.to_owned();
            cursor += 2;
        } else {
            break;
        }
    }
    Some((name, cursor))
}

fn apply_create_table(statement: &[Tok], file: &Path, schema: &mut Schema) {
    let index = skip_if_clause(statement, 2);
    let Some((table, after_name)) = read_qualified_name(statement, index) else {
        return;
    };
    // `CREATE TABLE x PARTITION OF y …` inherits its parent's columns and is
    // not an independently classifiable relation. This repo creates partitions
    // only inside plpgsql (0005), which the lexer already drops, but the guard
    // keeps a hand-written partition from inventing an empty table.
    if statement
        .get(after_name)
        .and_then(Tok::word)
        .is_some_and(|w| w == "partition")
    {
        return;
    }
    let Some(body) = parenthesised_body(statement, after_name) else {
        return;
    };
    let entry = schema.tables.entry(table.clone()).or_default();
    for item in split_top_level_commas(body) {
        let Some(first) = item.first().and_then(Tok::word) else {
            continue;
        };
        if CONSTRAINT_HEADS.contains(&first) {
            continue;
        }
        entry.insert(first.to_owned());
        schema
            .origins
            .insert((table.clone(), first.to_owned()), file.to_path_buf());
    }
}

fn apply_alter_table(statement: &[Tok], file: &Path, schema: &mut Schema) {
    let index = skip_if_clause(statement, 2);
    let Some((table, after_name)) = read_qualified_name(statement, index) else {
        return;
    };
    if !schema.tables.contains_key(&table) {
        return;
    }
    // Each comma-separated action is parsed independently. 0066 uses the
    // multi-`ADD COLUMN` form (twelve columns in one statement); a parser that
    // reads only the first action undercounts `employees` by eleven.
    for action in split_top_level_commas(&statement[after_name..]) {
        let words: Vec<&str> = action.iter().take(6).filter_map(Tok::word).collect();
        match words.first().copied() {
            Some("add") => {
                let mut cursor = 1usize;
                if action.get(cursor).and_then(Tok::word) == Some("column") {
                    cursor += 1;
                } else if action
                    .get(cursor)
                    .and_then(Tok::word)
                    .is_some_and(|w| CONSTRAINT_HEADS.contains(&w))
                {
                    continue;
                }
                cursor = skip_if_clause(action, cursor);
                if let Some(column) = action.get(cursor).and_then(Tok::word) {
                    schema
                        .tables
                        .entry(table.clone())
                        .or_default()
                        .insert(column.to_owned());
                    schema
                        .origins
                        .insert((table.clone(), column.to_owned()), file.to_path_buf());
                }
            }
            Some("drop") => {
                let mut cursor = 1usize;
                if action.get(cursor).and_then(Tok::word) == Some("column") {
                    cursor += 1;
                } else {
                    continue;
                }
                cursor = skip_if_clause(action, cursor);
                if let Some(column) = action.get(cursor).and_then(Tok::word)
                    && let Some(columns) = schema.tables.get_mut(&table)
                {
                    columns.remove(column);
                    schema.origins.remove(&(table.clone(), column.to_owned()));
                }
            }
            _ => {}
        }
    }
}

fn drop_table_targets(statement: &[Tok]) -> Vec<String> {
    let index = skip_if_clause(statement, 2);
    let mut targets = Vec::new();
    let mut cursor = index;
    while let Some((name, next)) = read_qualified_name(statement, cursor) {
        targets.push(name);
        if statement.get(next).is_some_and(|t| t.is_punct(',')) {
            cursor = next + 1;
        } else {
            break;
        }
    }
    targets
}

/// Return the token slice inside the first balanced `( … )` at or after `from`.
fn parenthesised_body(statement: &[Tok], from: usize) -> Option<&[Tok]> {
    let open = (from..statement.len()).find(|i| statement[*i].is_punct('('))?;
    let mut depth = 0usize;
    for index in open..statement.len() {
        if statement[index].is_punct('(') {
            depth += 1;
        } else if statement[index].is_punct(')') {
            depth -= 1;
            if depth == 0 {
                return Some(&statement[open + 1..index]);
            }
        }
    }
    None
}

fn split_top_level_commas(tokens: &[Tok]) -> Vec<&[Tok]> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    for (index, token) in tokens.iter().enumerate() {
        if token.is_punct('(') {
            depth += 1;
        } else if token.is_punct(')') {
            depth = depth.saturating_sub(1);
        } else if token.is_punct(',') && depth == 0 {
            if index > start {
                out.push(&tokens[start..index]);
            }
            start = index + 1;
        }
    }
    if start < tokens.len() {
        out.push(&tokens[start..]);
    }
    out
}

// ---------------------------------------------------------------------------
// Marker parse
// ---------------------------------------------------------------------------

/// One `COMMENT ON COLUMN … IS 'pd:…'` marker.
#[derive(Debug, Clone)]
pub struct Marker {
    /// Table the marker names.
    pub table: String,
    /// Column the marker names.
    pub column: String,
    /// Tokens, verbatim, before validation.
    pub tokens: Vec<String>,
    /// Free-text note after the token list.
    pub note: String,
    /// Migration file holding the marker.
    pub file: PathBuf,
}

/// Collect every classification marker across the given migration files.
#[must_use]
pub fn parse_markers(files: &[PathBuf]) -> Vec<Marker> {
    let mut markers = Vec::new();
    for file in files {
        let Ok(content) = fs::read_to_string(file) else {
            continue;
        };
        let tokens = lex(&content);
        for statement in statements(&tokens) {
            let head: Vec<&str> = statement.iter().take(3).filter_map(Tok::word).collect();
            if head.first().copied() != Some("comment")
                || head.get(1).copied() != Some("on")
                || head.get(2).copied() != Some("column")
            {
                continue;
            }
            let Some(marker) = read_marker(statement, file) else {
                continue;
            };
            markers.push(marker);
        }
    }
    markers
}

fn read_marker(statement: &[Tok], file: &Path) -> Option<Marker> {
    // COMMENT ON COLUMN [schema.]table.column IS 'body'
    let mut parts: Vec<String> = Vec::new();
    let mut cursor = 3usize;
    loop {
        let word = statement.get(cursor)?.word()?;
        if word == "is" {
            break;
        }
        parts.push(word.to_owned());
        cursor += 1;
        if statement.get(cursor).is_some_and(|t| t.is_punct('.')) {
            cursor += 1;
        } else {
            break;
        }
    }
    while statement.get(cursor).and_then(Tok::word) != Some("is") {
        cursor += 1;
        if cursor >= statement.len() {
            return None;
        }
    }
    let body = match statement.get(cursor + 1)? {
        Tok::Str(s) => s.clone(),
        _ => return None,
    };
    let column = parts.pop()?;
    let table = parts.pop()?;

    let rest = body.strip_prefix(MARKER_PREFIX)?;
    let (token_text, note) = match rest.find(char::is_whitespace) {
        Some(at) => (&rest[..at], rest[at..].trim().to_owned()),
        None => (rest, String::new()),
    };
    let tokens = token_text
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect();

    Some(Marker {
        table,
        column,
        tokens,
        note,
        file: file.to_path_buf(),
    })
}

/// Validate one token against the closed vocabulary.
///
/// Returns the offending detail when the token is not usable.
fn validate_token(token: &str) -> Result<&'static ClassCitation, (ViolationKind, String)> {
    let (head, sub) = match token.split_once('/') {
        Some((head, sub)) => (head, Some(sub)),
        None => (token, None),
    };
    let Some(citation) = citation_for(head) else {
        return Err((
            ViolationKind::UnknownToken,
            format!(
                "token '{token}' is not in the closed vocabulary [{}]",
                VOCABULARY
                    .iter()
                    .map(|c| c.token)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ));
    };
    if citation.subtokens.is_empty() {
        if sub.is_some() {
            return Err((
                ViolationKind::BadSubtoken,
                format!("class '{head}' takes no sub-token but got '{token}'"),
            ));
        }
        return Ok(citation);
    }
    let Some(sub) = sub else {
        return Err((
            ViolationKind::BadSubtoken,
            format!(
                "class '{head}' requires a sub-token — one of [{}] — because {} ({}) draws \
                 distinctions this gate will not collapse",
                citation.subtokens.join(", "),
                citation.instrument,
                citation.article,
            ),
        ));
    };
    if !citation.subtokens.contains(&sub) {
        return Err((
            ViolationKind::BadSubtoken,
            format!(
                "sub-token '{sub}' is not valid for class '{head}'; {} ({}) admits only [{}]",
                citation.instrument,
                citation.article,
                citation.subtokens.join(", "),
            ),
        ));
    }
    Ok(citation)
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/// Parse a baseline file into its table set, ignoring blanks and `#` comments.
#[must_use]
pub fn parse_baseline(text: &str) -> BTreeSet<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_ascii_lowercase)
        .collect()
}

/// Run the gate against a workspace root, reading the checked-in baseline.
///
/// # Errors
/// Returns an error when the migration tree or the baseline file cannot be read.
pub fn check_workspace(workspace_dir: &Path) -> Result<GateResult, String> {
    let baseline_path = workspace_dir.join(BASELINE_RELATIVE_PATH);
    let baseline = fs::read_to_string(&baseline_path)
        .map_err(|e| format!("cannot read baseline {}: {e}", baseline_path.display()))?;
    let files = collect_migration_files(workspace_dir)?;
    Ok(check_files(&files, &parse_baseline(&baseline)))
}

/// Run the gate against an explicit migration tree and baseline set.
///
/// # Errors
/// Returns an error when the tree cannot be walked.
pub fn check_tree(root: &Path, baseline: &BTreeSet<String>) -> Result<GateResult, String> {
    let files = collect_migration_files(root)?;
    Ok(check_files(&files, baseline))
}

/// Run the gate over an explicit, ordered file list.
#[must_use]
pub fn check_files(files: &[PathBuf], baseline: &BTreeSet<String>) -> GateResult {
    let schema = parse_schema(files);
    let markers = parse_markers(files);

    let mut result = GateResult {
        total_tables: schema.tables.len(),
        total_columns: schema.column_count(),
        baselined_tables: baseline.len(),
        ..GateResult::default()
    };

    // 1. Marker well-formedness, existence and uniqueness.
    let mut classified: BTreeMap<(String, String), &Marker> = BTreeMap::new();
    for marker in &markers {
        let key = (marker.table.clone(), marker.column.clone());
        let exists = schema
            .tables
            .get(&marker.table)
            .is_some_and(|columns| columns.contains(&marker.column));
        if !exists {
            result.push(
                ViolationKind::MarkerForUnknownColumn,
                Some(marker.file.clone()),
                format!(
                    "marker classifies {}.{}, which the migration parse says does not exist",
                    marker.table, marker.column
                ),
            );
            continue;
        }
        if marker.tokens.is_empty() {
            result.push(
                ViolationKind::EmptyMarker,
                Some(marker.file.clone()),
                format!(
                    "marker on {}.{} carries the '{MARKER_PREFIX}' prefix but no tokens",
                    marker.table, marker.column
                ),
            );
            continue;
        }
        let mut token_ok = true;
        for token in &marker.tokens {
            if let Err((kind, detail)) = validate_token(token) {
                result.push(
                    kind,
                    Some(marker.file.clone()),
                    format!("{}.{}: {detail}", marker.table, marker.column),
                );
                token_ok = false;
            }
        }
        if !token_ok {
            continue;
        }
        if let Some(previous) = classified.insert(key, marker) {
            result.push(
                ViolationKind::DuplicateMarker,
                Some(marker.file.clone()),
                format!(
                    "{}.{} is classified twice (also {})",
                    marker.table,
                    marker.column,
                    previous.file.display()
                ),
            );
        }
    }
    result.classified_columns = classified.len();

    // 2. Completeness for every table outside the baseline. A NEW table is
    //    never in the baseline, so this is what forces classification at
    //    creation.
    for (table, columns) in &schema.tables {
        if baseline.contains(table) {
            continue;
        }
        for column in columns {
            if classified.contains_key(&(table.clone(), column.clone())) {
                continue;
            }
            let origin = schema
                .origins
                .get(&(table.clone(), column.clone()))
                .cloned();
            result.push(
                ViolationKind::UnclassifiedColumn,
                origin,
                format!(
                    "{table}.{column} has no personal-data classification — add \
                     `COMMENT ON COLUMN {table}.{column} IS '{MARKER_PREFIX}<tokens> …';` in the \
                     migration that creates it, or list '{table}' in {BASELINE_RELATIVE_PATH}"
                ),
            );
        }
    }

    // 3. The baseline is a ratchet: it may only shrink, and it may not rot.
    for table in baseline {
        let Some(columns) = schema.tables.get(table) else {
            result.push(
                ViolationKind::BaselineEntryUnknownTable,
                None,
                format!(
                    "baseline lists '{table}', which no migration creates — remove it from \
                     {BASELINE_RELATIVE_PATH}"
                ),
            );
            continue;
        };
        let unclassified = columns
            .iter()
            .filter(|column| !classified.contains_key(&(table.clone(), (*column).clone())))
            .count();
        if unclassified == 0 {
            result.push(
                ViolationKind::BaselineEntryFullyClassified,
                None,
                format!(
                    "all {} column(s) of '{table}' are now classified — remove '{table}' from \
                     {BASELINE_RELATIVE_PATH} so the ratchet holds",
                    columns.len()
                ),
            );
        }
    }

    result
}

// ---------------------------------------------------------------------------
// File discovery — same walk as the migration-safety gate.
// ---------------------------------------------------------------------------

/// Collect every `.sql` file under any directory named `migrations`, sorted.
///
/// # Errors
/// Returns an error when a directory cannot be read.
pub fn collect_migration_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_inner(root, false, &mut files)?;
    files.sort();
    Ok(files)
}

/// Directories whose contents are never first-party migrations.
///
/// `buck-out` is load-bearing, not defensive tidiness. Buck materialises every
/// third-party crate's source there, and several ship migrations of their own —
/// `apalis-postgres` has `migrations/*.sql`, `sqlx` has SQLite test fixtures.
/// Walking into it makes the gate classify `jobs`, `workers`, `user`, `post` and
/// `comment` as if they were ours, and makes the result depend on whether anyone
/// has run Buck locally: 31 violations on a developer's machine, silent on a
/// fresh CI checkout where `buck-out` does not exist yet. A gate whose verdict
/// depends on build residue is worse than no gate, because the green is not
/// reproducible.
const SKIP_DIRS: &[&str] = &["target", ".git", "buck-out", "node_modules"];

fn collect_inner(dir: &Path, in_migrations: bool, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if dir
        .components()
        .any(|c| SKIP_DIRS.contains(&c.as_os_str().to_string_lossy().as_ref()))
    {
        return Ok(());
    }
    let entries =
        fs::read_dir(dir).map_err(|e| format!("cannot read directory {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot read entry in {}: {e}", dir.display()))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
        if file_type.is_dir() {
            let is_migrations = entry.file_name().to_string_lossy() == "migrations";
            collect_inner(&path, in_migrations || is_migrations, files)?;
        } else if file_type.is_file()
            && in_migrations
            && path.extension().is_some_and(|ext| ext == "sql")
        {
            files.push(path);
        }
    }
    Ok(())
}
