# hidden test used by CI: the researcher's work is in $1
cd "$1"
has=0; [ -f results.json ] && has=1
echo "{\"has_results\": $has, \"files\": $(ls -A | wc -l)}"
