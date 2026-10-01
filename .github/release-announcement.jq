# Turns an annotated tag's message into a Bot API sendRichMessage payload.
#
# Input (raw, -R -s): the tag message body, i.e. everything after the subject.
# Arguments: --arg chat_id --arg tag --arg version --arg subject --arg repo_url
#            --arg image
#
# The notes travel as plain JSON strings inside explicit blocks, never as
# Markdown or HTML, so nothing in them can be parsed as formatting or markup
# and there is nothing to escape.

# Joins wrapped lines back into one, as the tag message wraps at ~78 columns.
def unwrap: map(sub("^\\s+"; "")) | join(" ");

# One blank-line-separated chunk of the notes becomes one or two blocks: any
# leading lines as a paragraph (or a heading, when it is a single short line
# with no full stop, like "Fixes"), then any "- " lines as a bulleted list.
def chunk_blocks:
  split("\n") as $lines
  | ([$lines | to_entries[] | select(.value | test("^- ")) | .key] | first) as $first
  | (if $first == null then $lines else $lines[:$first] end) as $lead
  | (if $first == null then [] else $lines[$first:] end) as $rest
  | (if ($lead | length) == 0 then []
     elif ($lead | length) == 1 and ($lead[0] | length) <= 40 and ($lead[0] | test("[.:]$") | not)
       then [{type: "heading", size: 3, text: $lead[0]}]
     else [{type: "paragraph", text: ($lead | unwrap)}]
     end)
  + (if ($rest | length) == 0 then []
     else
       [{type: "list",
         items: (
           reduce $rest[] as $l ([];
             if ($l | test("^- ")) then . + [[($l | sub("^- "; ""))]]
             else .[:-1] + [.[-1] + [$l]] end)
           | map({blocks: [{type: "paragraph", text: unwrap}]}))}]
     end);

(. | sub("\\s+$"; "")) as $body
| ($body | split("\n\n") | map(select(test("\\S")))) as $chunks
| {
    chat_id: $chat_id,
    rich_message: {
      skip_entity_detection: true,
      blocks: (
        [ {type: "heading", size: 2,
           text: ["share-stories ", {type: "bold", text: $version}]},
          {type: "paragraph", text: {type: "italic", text: $subject}} ]
        + ($chunks | map(chunk_blocks) | add // [])
        + [ {type: "divider"},
            {type: "paragraph",
             text: ["Image: ", {type: "code", text: "\($image):\($version)"}]},
            {type: "buttons", align: "center",
             buttons: [
               {text: "Release notes", url: "\($repo_url)/releases/tag/\($tag)"},
               {text: "Container image", url: "\($repo_url)/pkgs/container/share-stories"}
             ]},
            {type: "footer", text: "Also tagged \($version | split(".")[:2] | join(".")) and latest"} ]
      )
    }
  }
