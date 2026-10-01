# Turns an annotated tag's message into a Bot API sendRichMessage payload.
#
# Input (raw, -R -s): the tag message body, i.e. everything after the subject.
# Arguments: --arg chat_id --arg tag --arg version --arg subject --arg repo_url
#            --arg image --arg banner_url (empty when the repo has no banner)
#
# The notes travel as plain JSON strings inside explicit blocks, never as
# Markdown or HTML, so nothing in them can be parsed as formatting or markup
# and there is nothing to escape.

# Joins wrapped lines back into one, as the tag message wraps at ~78 columns.
def unwrap: map(sub("^\\s+"; "")) | join(" ");

# A section title gets an emoji matching what it holds; anything unrecognised
# still gets one, so every section reads the same.
def section_emoji:
  ascii_downcase as $t
  | if ($t | test("fix|bug")) then "🐛"
    elif ($t | test("feat|new|add")) then "✨"
    elif ($t | test("secur|cve|advisor")) then "🔒"
    elif ($t | test("break|upgrade|migrat")) then "⚠️"
    elif ($t | test("depend")) then "📦"
    else "📝" end;

def titled: "\(section_emoji) \(.)";

# A paragraph that warns about upgrading ("Upgrade note: …") is folded like
# the lists: its title stays visible with a warning sign, and the explanation,
# usually the longest text in the notes, opens on a tap.
def lead_block:
  if test("^(upgrade|breaking|migration) note:"; "i") then
    capture("^(?<title>[^:]+):\\s*(?<rest>.*)$"; "s") as $m
    | {type: "details",
       summary: {type: "bold", text: "⚠️ \($m.title)"},
       blocks: [{type: "paragraph",
                 text: (($m.rest[0:1] | ascii_upcase) + $m.rest[1:])}]}
  else {type: "paragraph", text: .} end;

# "- " lines (with their wrapped continuations) as one bulleted list block.
def list_block:
  {type: "list",
   items: (
     reduce .[] as $l ([];
       if ($l | test("^- ")) then . + [[($l | sub("^- "; ""))]]
       else .[:-1] + [.[-1] + [$l]] end)
     | map({blocks: [{type: "paragraph", text: unwrap}]}))};

# One blank-line-separated chunk of the notes. A short title line followed by
# "- " items becomes a collapsed section, so a long list of fixes does not
# bury the rest of the message; otherwise the lead lines are a paragraph (or a
# heading, when it is a single short line with no full stop) and any items a
# plain list.
def chunk_blocks:
  split("\n") as $lines
  | ([$lines | to_entries[] | select(.value | test("^- ")) | .key] | first) as $first
  | (if $first == null then $lines else $lines[:$first] end) as $lead
  | (if $first == null then [] else $lines[$first:] end) as $rest
  | (($lead | length) == 1 and ($lead[0] | length) <= 40
     and ($lead[0] | test("[.:]$") | not)) as $is_title
  | if $is_title and ($rest | length) > 0 then
      [{type: "details",
        summary: {type: "bold", text: ($lead[0] | titled)},
        blocks: [$rest | list_block]}]
    else
      (if ($lead | length) == 0 then []
       elif $is_title then [{type: "heading", size: 3, text: ($lead[0] | titled)}]
       else [$lead | unwrap | lead_block]
       end)
      + (if ($rest | length) == 0 then [] else [$rest | list_block] end)
    end;

(. | sub("\\s+$"; "")) as $body
| ($body | split("\n\n") | map(select(test("\\S")))) as $chunks
| {
    chat_id: $chat_id,
    rich_message: {
      skip_entity_detection: true,
      blocks: (
        (if $banner_url == "" then []
         else [{type: "photo", photo: {type: "photo", media: $banner_url}}] end)
        + [ {type: "heading", size: 1,
             text: ["🚀 share-stories ", {type: "bold", text: $version}]},
            # Blocks carry no spacing of their own; a line holding only a
            # non-breaking space sets the version apart from its subject.
            {type: "paragraph", text: "\u00a0"},
            {type: "paragraph", text: ["✨ ", {type: "italic", text: $subject}]} ]
        + ($chunks | map(chunk_blocks) | add // [])
        + [ {type: "divider"},
            # A code block rather than inline code: Telegram gives it a copy
            # button, and the whole pull command is what people paste.
            {type: "paragraph", text: {type: "bold", text: "🐳 Docker image"}},
            {type: "pre", language: "bash", text: "docker pull \($image):\($version)"},
            {type: "buttons", align: "center",
             buttons: [
               {text: "📝 Notes", url: "\($repo_url)/releases/tag/\($tag)"},
               {text: "📦 Package", url: "\($repo_url)/pkgs/container/share-stories"}
             ]},
            {type: "footer", text: "🏷️ Also tagged \($version | split(".")[:2] | join(".")) and latest"} ]
      )
    }
  }
