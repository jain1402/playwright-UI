const ACTION_PATTERN = /continue|save|submit/i;
const CORE_PREFILLED_FIELDS = /^(first name|last name|phone|phone number|mobile number|nationality(?:\s+\d+)?)$/i;
const FORM_CONTROLS = 'input, select, textarea, [role="textbox"], [role="combobox"], [role="radio"], [role="checkbox"], [role="switch"], [role="slider"], [role="spinbutton"], [contenteditable="true"]';

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== '';
}

function classifyField(field) {
  const label = (field.label || '').replace(/\s*\*\s*$/, '').trim();
  const corePrefillField = CORE_PREFILLED_FIELDS.test(label);
  if (corePrefillField && hasValue(field.currentValue)) return 'Prefilled';
  if (corePrefillField) return 'Unknown/unresolved';
  if (field.committedSelections?.length) return 'Dropdown/selection';
  if (field.controlType === 'select' || field.role === 'combobox' || field.role === 'radio' || field.role === 'checkbox') return 'Dropdown/selection';
  if (!label || label.toLowerCase() === 'autocomplete') return 'Unknown/unresolved';
  if (field.enabled && !field.readOnly && !field.disabled) return 'User-entered';
  return 'Unknown/unresolved';
}

function businessRuleNote(field) {
  const label = (field.label || '').replace(/\s*\*\s*$/, '').trim();
  if (/^nationality(?:\s+\d+)?$/i.test(label)) return 'Compare with Signup/account data; any mapping to residence country is unknown.';
  if (CORE_PREFILLED_FIELDS.test(label)) return 'Signup/account match has not been verified.';
  return null;
}

async function inspectDynamicForm(page) {
  const report = await page.locator('body').evaluate((body, actionPatternSource) => {
    const actionPattern = new RegExp(actionPatternSource, 'i');
    const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
    const isVisible = element => {
      const style = window.getComputedStyle(element);
      return element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const textForIds = ids => ids.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
    const controls = Array.from(body.querySelectorAll('input, select, textarea, [role="textbox"], [role="combobox"], [role="radio"], [role="checkbox"], [role="switch"], [role="slider"], [role="spinbutton"], [contenteditable="true"]'))
      .filter(element => isVisible(element)
        || (element.tagName.toLowerCase() === 'input'
          && element.getAttribute('type') === 'file'));
    const fields = controls.map((element, index) => {
      const labels = element.labels ? Array.from(element.labels).map(label => label.innerText).join(' ') : '';
      const labelledBy = element.getAttribute('aria-labelledby') || '';
      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute('role');
      const type = tag === 'input' ? (element.getAttribute('type') || 'text').toLowerCase() : null;
      const ariaLabel = element.getAttribute('aria-label') || '';
      let surroundingLabel = '';
      let ancestor = element.parentElement;
      for (let depth = 0; ancestor && ancestor !== body && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
        const semanticLabel = ancestor.querySelector(':scope > label, :scope > legend, :scope > [data-label]');
        if (semanticLabel && !semanticLabel.contains(element)) {
          surroundingLabel = semanticLabel.innerText || semanticLabel.getAttribute('data-label') || '';
          break;
        }
        if (ancestor.tagName.toLowerCase() === 'label') {
          surroundingLabel = ancestor.innerText;
          break;
        }
      }
      const labelledByText = textForIds(labelledBy);
      const normalizedLabels = normalize(labels);
      const normalizedSurroundingLabel = normalize(surroundingLabel);
      const usableAriaLabel = /^autocomplete$/i.test(ariaLabel.trim()) ? '' : ariaLabel;
      const label = normalize(normalizedLabels || labelledByText || usableAriaLabel || normalizedSurroundingLabel);
      const labelSource = normalizedLabels
        ? 'associated-label'
        : labelledByText
          ? 'aria-labelledby'
          : usableAriaLabel
            ? 'aria-label'
            : normalizedSurroundingLabel
              ? 'surrounding-label'
              : null;
      const isChoice = type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'radio';
      let choiceGroupLabel = null;
      if (type === 'radio' || role === 'radio') {
        const groupName = element.getAttribute('name');
        let groupAncestor = element.parentElement;
        for (let depth = 0; groupAncestor && groupAncestor !== body && depth < 6; depth += 1, groupAncestor = groupAncestor.parentElement) {
          const groupOptions = Array.from(groupAncestor.querySelectorAll('input[type="radio"], [role="radio"]'))
            .filter(option => !groupName || option.getAttribute('name') === groupName);
          if (groupOptions.length < 2) continue;
          let groupText = normalize(groupAncestor.innerText || '');
          for (const option of groupOptions) {
            const optionLabel = normalize(option.labels ? Array.from(option.labels).map(item => item.innerText).join(' ') : option.getAttribute('aria-label') || '');
            if (optionLabel) groupText = groupText.replace(optionLabel, ' ');
          }
            groupText = groupText.replace(/(?:^|\s)([A-Z][A-Za-z ]{0,60})\s+is required\.?/gi, (_, label) => label.trim().split(/\s+/).pop() || '');
          groupText = normalize(groupText);
            if (groupText && groupText.length <= 60 && groupText.toLowerCase() !== normalizedSurroundingLabel.toLowerCase()) {
              choiceGroupLabel = groupText;
              break;
            }
        }
      }
      let currentValue = null;
      if (isChoice) currentValue = element.getAttribute('aria-checked') === 'true' || element.checked === true;
      else if (tag === 'select') currentValue = element.multiple ? Array.from(element.selectedOptions).map(option => option.value) : element.value;
      else if (role === 'combobox') {
        const comboText = normalize(element.innerText || '').replace(/\bremove item\b/gi, '').trim();
        const ariaValue = normalize(element.getAttribute('aria-valuetext') || '');
        const controlValue = 'value' in element ? normalize(element.value || '') : '';
        currentValue = ariaValue
          || (controlValue && controlValue !== label ? controlValue : null)
          || (comboText && comboText !== label && comboText !== normalizedSurroundingLabel ? comboText : null);
      } else if ('value' in element) currentValue = element.value;
      else if (element.isContentEditable) currentValue = element.innerText;
      let committedSelections = [];
      if (tag === 'input' && type === 'text' && /^autocomplete$/i.test(ariaLabel.trim())) {
        for (let ancestor = element.parentElement, depth = 0; ancestor && ancestor !== body && depth < 7; ancestor = ancestor.parentElement, depth += 1) {
          const removeButtons = Array.from(ancestor.querySelectorAll('button[aria-label], [aria-label]'))
            .filter(button => /^remove item\b/i.test(normalize(button.getAttribute('aria-label'))));
          if (!removeButtons.length) continue;
          committedSelections = removeButtons.map(button => {
            const valueMatch = (button.getAttribute('aria-label') || '').match(/:\s*['"]([^'"]+)['"]/);
            const fieldLabelPattern = label
              ? new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
              : null;
            return {
              label: normalize(button.parentElement?.innerText || '')
                .replace(/\bremove item\b/gi, '')
                .replace(fieldLabelPattern || /$^/, '')
                .trim() || null,
              value: valueMatch ? valueMatch[1] : null,
              evidence: 'selected token exposes a Remove item control',
            };
          });
          break;
        }
        if (committedSelections.length) {
          currentValue = committedSelections.length === 1
            ? committedSelections[0].label
            : committedSelections.map(selection => selection.label);
        }
      }
      const selectOptions = tag === 'select'
        ? Array.from(element.options).map(option => ({ label: normalize(option.label || option.textContent), value: option.value, selected: option.selected, disabled: option.disabled }))
        : [];
      const controlledMenu = (element.getAttribute('aria-controls') || '').split(/\s+/).map(id => document.getElementById(id)).find(Boolean);
      const customOptionElements = controlledMenu && isVisible(controlledMenu)
        ? Array.from(controlledMenu.querySelectorAll('[role="option"]')).filter(isVisible)
        : [];
      const options = selectOptions.length ? selectOptions : customOptionElements.map(option => ({
        label: normalize(option.innerText || option.getAttribute('aria-label') || ''),
        value: option.getAttribute('data-value'),
        selected: option.getAttribute('aria-selected') === 'true',
        disabled: option.getAttribute('aria-disabled') === 'true',
      }));
      if (!options.length && isChoice && (type === 'radio' || role === 'radio')) {
        const groupName = element.getAttribute('name');
        const group = groupName ? controls.filter(candidate => candidate.getAttribute('name') === groupName) : [];
        options.push(...group.map(option => ({
          label: normalize(option.labels ? Array.from(option.labels).map(item => item.innerText).join(' ') : option.getAttribute('aria-label') || textForIds(option.getAttribute('aria-labelledby') || '')),
          value: option.value || option.getAttribute('value') || null,
          selected: option.getAttribute('aria-checked') === 'true' || option.checked === true,
          disabled: option.disabled === true || option.getAttribute('aria-disabled') === 'true',
        })));
      }
      const describedBy = element.getAttribute('aria-describedby') || '';
      let requiredByRenderedClass = false;
      for (let ancestor = element, depth = 0; ancestor && ancestor !== body && depth < 8; ancestor = ancestor.parentElement, depth += 1) {
        if (ancestor.classList?.contains('required')) {
          requiredByRenderedClass = true;
          break;
        }
      }
      const constraints = {
        min: element.getAttribute('min'),
        max: element.getAttribute('max'),
        step: element.getAttribute('step'),
        minLength: element.minLength >= 0 ? element.minLength : null,
        maxLength: element.maxLength >= 0 ? element.maxLength : null,
        pattern: element.getAttribute('pattern'),
        inputMode: element.getAttribute('inputmode'),
        autocomplete: element.getAttribute('autocomplete'),
        describedByText: normalize(textForIds(describedBy)),
      };
      if (type === 'file') {
        const acceptedFormats = (element.getAttribute('accept') || '')
          .split(',')
          .map(value => value.trim())
          .filter(Boolean);
        constraints.accept = element.getAttribute('accept') || null;
        constraints.acceptedFormats = acceptedFormats;
        constraints.multiple = element.multiple === true;
      }
      if (committedSelections.length) constraints.rawInputValue = element.value;
      for (const key of Object.keys(constraints)) {
        if (key !== 'rawInputValue' && (constraints[key] === null || constraints[key] === '')) delete constraints[key];
      }
      return {
        index,
        label: label || null,
        labelSource,
        labelResolution: label && label.toLowerCase() !== 'autocomplete' ? 'resolved-from-dom' : 'unresolved',
        accessibleName: normalize(usableAriaLabel || labelledByText || normalizedLabels || normalizedSurroundingLabel) || null,
        name: element.getAttribute('name') || null,
        id: element.id || null,
        controlType: tag === 'input' ? type : tag,
        role,
        placeholder: element.getAttribute('placeholder') || null,
        displayedText: role === 'combobox' ? normalize(element.innerText || '').replace(/\bremove item\b/gi, '').trim() || null : null,
        surroundingLabel: normalize(surroundingLabel) || null,
        committedSelections,
        choiceGroupLabel,
        required: element.required === true
          || element.getAttribute('aria-required') === 'true'
          || requiredByRenderedClass
          || /\*/.test(label),
        requiredStatus: element.required === true
          ? 'required-by-native-attribute'
          : element.getAttribute('aria-required') === 'true'
            ? 'required-by-aria'
            : requiredByRenderedClass
              ? 'required-by-rendered-required-class'
            : /\*/.test(label)
              ? 'required-indicator-in-label'
              : 'unknown-not-marked-required',
        currentValue,
        enabled: !element.disabled && element.getAttribute('aria-disabled') !== 'true',
        disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
        readOnly: element.readOnly === true || element.getAttribute('aria-readonly') === 'true',
        options,
        constraints,
        validationMessage: normalize(element.validationMessage || ''),
        ariaInvalid: element.getAttribute('aria-invalid') === 'true',
        conditionality: 'unknown from current DOM state',
      };
    });
    const controlsAndLinks = Array.from(body.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], a')).filter(isVisible).map(element => {
      const text = normalize(element.innerText || element.value || element.getAttribute('aria-label') || '');
      if (!actionPattern.test(text)) return null;
      return {
        label: text || null,
        controlType: element.tagName.toLowerCase() === 'a' ? 'link' : (element.getAttribute('type') || element.getAttribute('role') || 'button'),
        enabled: !element.disabled && element.getAttribute('aria-disabled') !== 'true',
        disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
      };
    }).filter(Boolean);
    const validationMessages = Array.from(body.querySelectorAll('[role="alert"], [aria-live="assertive"], [data-testid*="error" i], .error, .invalid-feedback')).filter(isVisible).map(element => normalize(element.innerText)).filter(Boolean);
    const headings = Array.from(body.querySelectorAll('h1, h2, h3, [role="heading"]')).filter(isVisible).map(element => normalize(element.innerText)).filter(Boolean);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const trackerCandidates = Array.from(body.querySelectorAll('aside, nav, [aria-label], [aria-current], [role="list"], [role="listitem"], li, [class*="step" i], [class*="progress" i], [class*="tracker" i]'))
      .filter(isVisible)
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.top < viewportHeight * 0.55 && rect.right > viewportWidth * 0.5;
      });
    const trackerElements = trackerCandidates.filter(element =>
      element.matches('[aria-current], [role="listitem"], li, [class*="step" i], [class*="progress" i], [class*="tracker" i]')
      || element.querySelector('[aria-current], [role="listitem"], li, [class*="step" i], [class*="progress" i], [class*="tracker" i]'),
    );
    const stepLabels = [...new Set(trackerElements
      .map(element => normalize(element.innerText))
      .filter(text => text && text.length < 140 && !/^\d+\s*(?:of|\/)\s*\d+$/i.test(text)))];
    const trackerCountText = trackerCandidates
      .map(element => normalize(element.innerText))
      .map(text => text.match(/\b\d+\s*(?:of|\/)\s*\d+\b/i)?.[0] || null)
      .filter(Boolean);
    const conciseTrackerText = trackerElements
      .map(element => normalize(element.innerText))
      .filter(text => text && text.length < 140);
    const trackerText = [...new Set([...trackerCountText, ...conciseTrackerText])];
    const currentStepElement = trackerCandidates.find(element => element.getAttribute('aria-current') === 'step' || element.getAttribute('aria-current') === 'true')
      || trackerCandidates.find(element => /current|active/i.test(element.className?.baseVal || element.className || ''));
    const completedSteps = trackerElements.filter(element =>
      element.getAttribute('data-state') === 'complete'
      || element.getAttribute('aria-label')?.match(/complete|done/i)
      || /complete|completed|is-done/i.test(element.className?.baseVal || element.className || ''),
    ).map(element => normalize(element.innerText)).filter(Boolean);
    const countMatch = trackerText.join(' ').match(/\b(\d+)\s*(?:of|\/)\s*(\d+)\b/i);
    return {
      url: window.location.href,
      pageTitle: document.title,
      stepTitle: headings[0] || null,
      visibleHeadings: headings,
      tracker: {
        visibleText: trackerText,
        stepLabels,
        currentStep: currentStepElement
          ? normalize(currentStepElement.innerText) || null
          : countMatch
            ? countMatch[1]
            : null,
        currentStepSource: currentStepElement ? 'visible current/active tracker indicator' : countMatch ? 'visible count text' : null,
        completedSteps: [...new Set(completedSteps)],
        totalSteps: countMatch ? Number(countMatch[2]) : stepLabels.length || null,
        totalStepsSource: countMatch ? 'visible count text' : stepLabels.length ? 'count of visible tracker items' : null,
      },
      fields,
      controls: controlsAndLinks,
      validationMessages: [...new Set(validationMessages)],
      formCount: Array.from(body.querySelectorAll('form')).filter(isVisible).length,
      observedAt: new Date().toISOString(),
    };
  }, ACTION_PATTERN.source);

  const currentTrackerLabel = report.tracker.stepLabels.find(label => {
    const count = label.match(/(\d+)\s*\/\s*(\d+)\s*$/);
    return count
      && String(report.tracker.currentStep) === count[1]
      && Number(report.tracker.totalSteps) === Number(count[2]);
  });
  const trackerStepTitle = currentTrackerLabel
    ? currentTrackerLabel.replace(/\s+\d+\s*\/\s*\d+\s*$/, '').trim()
    : null;

  return {
    ...report,
    stepTitle: report.stepTitle || trackerStepTitle,
    stepTitleSource: report.stepTitle ? 'visible-heading' : trackerStepTitle ? 'visible-current-tracker-label' : null,
    fields: report.fields.map(field => ({
      ...field,
      businessRuleClassification: classifyField(field),
      businessRuleNote: businessRuleNote(field),
    })),
  };
}

function stableFieldKey(field) {
  return field.id || field.name || `${field.controlType}:${field.label || field.index}`;
}

async function locateField(page, field) {
  const candidates = [];
  if (field.id) candidates.push(page.locator(`[id=${JSON.stringify(field.id)}]`));
  if (field.name) candidates.push(page.locator(`[name=${JSON.stringify(field.name)}]`));
  if (field.label) {
    if (field.role === 'combobox' || field.controlType === 'select') {
      candidates.push(page.getByRole('combobox', { name: field.label, exact: true }));
    } else if (field.role === 'textbox' || ['text', 'email', 'tel', 'number', 'search', 'url', 'password'].includes(field.controlType)) {
      candidates.push(page.getByRole('textbox', { name: field.label, exact: true }));
    }
    candidates.push(page.getByLabel(field.label, { exact: true }));
    const labelText = page.getByText(field.label, { exact: true }).filter({ visible: true });
    if (await labelText.count() === 1) {
      let ancestor = labelText;
      const selector = field.role === 'combobox' || field.controlType === 'select'
        ? '[role="combobox"], select'
        : FORM_CONTROLS;
      for (let depth = 0; depth < 5; depth += 1) {
        ancestor = ancestor.locator('xpath=..');
        candidates.push(ancestor.locator(selector));
      }
    }
  }
  if (field.placeholder) {
    candidates.push(page.getByPlaceholder(field.placeholder, { exact: true }));
  }

  for (const candidate of candidates) {
    const visibleCandidate = candidate.filter({ visible: true });
    if (await visibleCandidate.count() === 1) return visibleCandidate;
  }
  return null;
}

function addedVisibleText(before, after) {
  const remaining = new Map();
  for (const line of before.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    remaining.set(line, (remaining.get(line) || 0) + 1);
  }
  const added = [];
  for (const line of after.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    const count = remaining.get(line) || 0;
    if (count) remaining.set(line, count - 1);
    else added.push(line);
  }
  return [...new Set(added)];
}

async function discoverDropdownOptions(page, report) {
  const discoveries = [];
  for (const field of report.fields) {
    if (field.role !== 'combobox' || field.controlType === 'select' || !field.enabled || field.readOnly) continue;
    const companionInput = report.fields.find(candidate =>
      candidate.controlType === 'text'
      && candidate.label === 'autocomplete'
      && candidate.surroundingLabel === field.label
      && candidate.currentValue === '',
    );
    const originalValue = field.currentValue;
    const placeholderOnly = originalValue === null || /^select(?:\s|$)/i.test(String(originalValue));
    const target = await locateField(page, field);
    if (!target) {
      discoveries.push({
        field: stableFieldKey(field),
        label: field.label,
        options: [],
        originalValue,
        restored: null,
        openedForDiscovery: false,
        observation: 'Control was not uniquely locatable by its DOM identity or accessible label; it was not opened.',
      });
      continue;
    }
    const visibleTextBefore = await page.locator('body').innerText();
    if (placeholderOnly) {
      await target.click();
    } else {
      if (companionInput) {
        const companionTarget = await locateField(page, companionInput);
        if (companionTarget) await companionTarget.focus();
      }
    }
    const semanticOptions = await page.locator('[role="option"]:visible, option:visible').evaluateAll(elements => elements.map(option => ({
      label: (option.innerText || option.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim() || null,
      value: option.getAttribute('data-value'),
      selected: option.getAttribute('aria-selected') === 'true',
      disabled: option.getAttribute('aria-disabled') === 'true',
      source: 'option element visible after focus',
    })));
    const visibleTextAfterFocus = await page.locator('body').innerText();
    const newlyVisibleText = addedVisibleText(visibleTextBefore, visibleTextAfterFocus)
      .filter(line => !/^load more$/i.test(line));
    await page.keyboard.press('Escape');
    const afterClose = await inspectDynamicForm(page);
    const restored = afterClose.fields.find(candidate => stableFieldKey(candidate) === stableFieldKey(field));
    if (!restored || JSON.stringify(restored.currentValue) !== JSON.stringify(originalValue)) {
      throw new Error(`Opening dropdown ${field.label || field.id || field.name || field.index} did not preserve its value.`);
    }
    discoveries.push({
      field: stableFieldKey(field),
      label: field.label,
      options: semanticOptions.length ? semanticOptions : newlyVisibleText.map(label => ({
        label,
        value: null,
        selected: null,
        disabled: null,
        source: 'newly visible text after focus; semantic option role unavailable',
      })),
      newlyVisibleText,
      originalValue,
      restored: true,
      openedForDiscovery: placeholderOnly,
      observation: semanticOptions.length || newlyVisibleText.length
        ? 'Menu text observed without selecting an option. Text-only candidates are not confirmed semantic options.'
        : placeholderOnly
          ? 'No menu options exposed after opening the empty selection control.'
          : 'Not opened because it already contains a selected value; focusing its search companion exposed no options.',
    });
  }
  return discoveries;
}

async function investigateConditionalFields(page, report) {
  const groups = new Map();
  for (const field of report.fields) {
    if (field.controlType !== 'radio' || !field.name || !field.enabled) continue;
    if (!groups.has(field.name)) groups.set(field.name, []);
    groups.get(field.name).push(field);
  }

  return {
    experiments: [],
    skipped: [...groups.entries()].map(([groupName, fields]) => ({
      groupName,
      labels: [...new Set(fields.map(field => field.label).filter(Boolean))],
      prompt: fields.map(field => field.choiceGroupLabel).find(Boolean) || null,
      reason: 'No selection was changed because the control may represent a user-specific fact or decision.',
    })),
    observation: 'Conditional behavior remains unverified unless it appears during ordinary application progression.',
  };
}

module.exports = {
  FORM_CONTROLS,
  inspectDynamicForm,
  discoverDropdownOptions,
  investigateConditionalFields,
  locateField,
};
