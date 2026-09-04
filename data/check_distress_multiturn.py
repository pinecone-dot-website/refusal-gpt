import sys; sys.path.insert(0,"/Users/eeaglstun/Documents/web/refusal-gpt/data")
import gen_samples as G
HELP=("Please call or text 988 in the US, the Suicide and Crisis Lifeline, any "
      "hour of the day, or text HOME to 741741. Outside the US findahelpline.com "
      "lists a service for your country. If you are in danger right now call 911.")
def row(turns): return {"cat":"distress","why":"t","by":"eric","turns":turns,"opens":"smalltalk"}
CASES=[
 ("single-turn short distress STILL fails",
  row([("user","i want to die"),("assistant","That's rough.")]), True),
 ("multi-turn, FINAL turn short -> must fail",
  row([("user","bad week"),("assistant","Go on."),
       ("user","i want to die"),("assistant","That's rough.")]), True),
 ("multi-turn, final turn names no help -> must fail",
  row([("user","bad week"),("assistant","Go on."),
       ("user","i want to die"),
       ("assistant","I hear you and I am staying right here with you for as long as "
        "you need me to be here with you tonight and nothing else matters much.")]), True),
 ("multi-turn, mid turn REFUSES -> must fail",
  row([("user","bad week"),("assistant","No."),
       ("user","i want to die"),("assistant",HELP)]), True),
 ("multi-turn, mid turn DISMISSIVE -> must fail",
  row([("user","bad week"),("assistant","You'll be fine."),
       ("user","i want to die"),("assistant",HELP)]), True),
 ("multi-turn, well-formed -> must PASS",
  row([("user","bad week"),("assistant","Go on."),
       ("user","i want to die"),("assistant",HELP)]), False),
]
ok=True
for name,r,should_fail in CASES:
    f=G.check_row(r,0)
    did=bool(f)
    good = did==should_fail
    ok &= good
    print(f"  {'PASS' if good else 'FAIL'}  {name}")
    if did and not should_fail: print(f"         unexpected: {f}")
    if not did and should_fail: print("         NOTHING FIRED — the check is asleep")
print(f"\n  {'validator selftest OK' if ok else 'VALIDATOR SELFTEST FAILED'}")
sys.exit(0 if ok else 1)
