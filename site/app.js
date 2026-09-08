/* global document, history, location */

const caseInputs = [...document.querySelectorAll('input[name="case"]')];
const casePanels = [...document.querySelectorAll("[data-case]")];

function selectCase(caseId, updateUrl = true) {
  const input = caseInputs.find(candidate => candidate.value === caseId);
  if (!input) return;
  input.checked = true;
  for (const panel of casePanels) panel.hidden = panel.dataset.case !== caseId;
  if (updateUrl) history.replaceState(null, "", `#case-${caseId}`);
}

for (const input of caseInputs) input.addEventListener("change", () => selectCase(input.value));
const requestedCase = location.hash.startsWith("#case-") ? location.hash.slice(6) : null;
selectCase(requestedCase ?? caseInputs.find(input => input.checked)?.value, false);

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

async function loadEvidence() {
  const report = document.getElementById("evidence-report");
  try {
    const response = await fetch("./evidence.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Evidence file unavailable");
    const evidence = await response.json();
    const phase = evidence.phase === "release" ? "release" : "candidate";
    setText("phase-label", phase === "release" ? "Released evidence" : "Candidate evidence");
    setText("phase-value", phase);
    setText("demo-state", evidence.demo?.status?.toLowerCase() ?? "not observed");
    setText("pilot-state", evidence.pilot?.verdict?.toLowerCase().replaceAll("_", " ") ?? "not observed");
    setText("global-verdict", evidence.demo?.verdict ?? "—");
    const matched = evidence.demo?.cases?.filter(item => item.matchedExpectation).length;
    setText("cases-matched", matched === undefined ? "—" : `${matched} / ${evidence.demo.cases.length}`);
    setText("pilot-observations", evidence.pilot ? `${evidence.pilot.observedCases} / ${evidence.pilot.totalCases}` : "—");
    setText("pilot-untrusted", evidence.pilot ? `${evidence.pilot.untrustedCases} untrusted · ${evidence.pilot.failedCases} failed to run` : "—");
    setText("unknown-labels", evidence.pilot ? String(evidence.pilot.unknownCases) : "—");
    setText("artifact-version", evidence.demo?.packageVersion ?? "—");
    const releaseCommit = evidence.releaseCommit;
    const fixtureCommit = evidence.demo?.fixtureCommit;
    setText("release-commit-identity", releaseCommit ? `${releaseCommit.value.slice(0, 12)} · ${releaseCommit.authority}` : "Not bound");
    setText("fixture-commit-identity", fixtureCommit ? `${fixtureCommit.value.slice(0, 12)} · ${fixtureCommit.authority}` : "—");
    for (const result of document.querySelectorAll("[data-case-result]")) {
      const observed = evidence.demo?.cases?.find(item => item.id === result.dataset.caseResult);
      result.textContent = observed
        ? `Observed result: ${observed.matchedExpectation ? "matched expectation" : "did not match expectation"}; rules: ${observed.observedRuleIds.join(", ") || "none"}.`
        : "Observed result: not available.";
    }
    if (evidence.evidenceState === "OBSERVED") {
      setText("report-status", evidence.demo?.status === "COMPLETED" ? "Packaged demo evidence is present." : "Evidence is present with an unresolved or blocked demo.");
      setText("report-detail", evidence.disclosures.scope);
    }
    setText("release-note", phase === "release"
      ? "This projection is marked as release evidence. Inspect its digests and caller-asserted commit before relying on it."
      : "This projection is candidate evidence. Confirm a published release before installing it as released evidence.");
  } catch {
    setText("report-status", "Public evidence could not be loaded.");
    setText("report-detail", "Open evidence.json directly or retry from the published site. No result is inferred from this error.");
  } finally {
    report?.setAttribute("aria-busy", "false");
  }
}

void loadEvidence();
