const fs = require('node:fs');
const path = require('node:path');

function findProjectEkycFixtures(projectRoot) {
  const fixtureDirectory = path.join(projectRoot, 'utils', 'testfile');
  if (!fs.existsSync(fixtureDirectory)) {
    return {
      directory: path.relative(projectRoot, fixtureDirectory),
      directoryExists: false,
      files: [],
      found: [],
    };
  }

  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
      } else if (entry.isFile()) {
        const stats = fs.statSync(filePath);
        files.push({
          path: path.relative(projectRoot, filePath),
          extension: path.extname(entry.name).toLowerCase(),
          sizeBytes: stats.size,
        });
      }
    }
  };
  visit(fixtureDirectory);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    directory: path.relative(projectRoot, fixtureDirectory),
    directoryExists: true,
    files,
    found: files
      .filter(file => /\.(?:pdf|png|jpe?g|docx?)$/i.test(file.extension))
      .map(file => file.path),
  };
}

async function inspectEkycUpload(page) {
  const inspection = await page.locator('body').evaluate(body => {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = element => {
      const style = window.getComputedStyle(element);
      return element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const cssPath = element => {
      const segments = [];
      let current = element;
      while (current && current !== body) {
        const tag = current.tagName.toLowerCase();
        if (current.id) {
          segments.unshift(`#${CSS.escape(current.id)}`);
          break;
        }
        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter(sibling => sibling.tagName === current.tagName)
          : [];
        const index = siblings.indexOf(current) + 1;
        segments.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
        current = current.parentElement;
      }
      return segments.join(' > ');
    };
    const textForIds = ids => String(ids || '').split(/\s+/)
      .map(id => document.getElementById(id)?.innerText || '')
      .filter(Boolean)
      .join(' ');
    const textLabelElements = Array.from(body.querySelectorAll('label, legend, [aria-label], [data-label], span, div, p'))
      .filter(element => isVisible(element) && normalize(element.innerText || element.getAttribute('aria-label') || element.getAttribute('data-label')).toLowerCase() === 'document type')
      .sort((left, right) => (left.innerText || '').length - (right.innerText || '').length);
    const labelElement = textLabelElements[0] || null;
    const candidateSelector = 'select, [role="combobox"], input:not([type="file"]), button, [aria-haspopup], [tabindex]:not([tabindex="-1"])';
    let documentTypeScope = null;
    let trigger = null;
    for (let ancestor = labelElement, depth = 0; ancestor && ancestor !== body && depth < 8; ancestor = ancestor.parentElement, depth += 1) {
      const candidates = Array.from(ancestor.querySelectorAll(candidateSelector))
        .filter(element => isVisible(element) && !element.disabled && !element.closest('[aria-hidden="true"]'))
        .filter(element => !/^(continue|submit|save)$/i.test(normalize(element.innerText || element.value || element.getAttribute('aria-label'))))
        .filter(element => !/^remove item\b/i.test(normalize(element.innerText || element.getAttribute('aria-label'))));
      if (!candidates.length) continue;
      documentTypeScope = ancestor;
      candidates.sort((left, right) => {
        const score = element => {
          if (element.tagName === 'SELECT') return 0;
          if (element.getAttribute('role') === 'combobox') return 1;
          if (element.tagName === 'INPUT' && element.type !== 'file') return 2;
          if (element.hasAttribute('aria-haspopup')) return 3;
          if (element.tagName === 'BUTTON') return 4;
          if (element.getAttribute('role') === 'listbox') return 6;
          return 5;
        };
        return score(left) - score(right);
      });
      trigger = candidates[0];
      break;
    }
    const describeControl = element => ({
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      name: element.getAttribute('name') || null,
      role: element.getAttribute('role'),
      type: element.getAttribute('type'),
      ariaLabel: element.getAttribute('aria-label'),
      placeholder: element.getAttribute('placeholder'),
      text: normalize(element.innerText || element.value || element.getAttribute('aria-label')) || null,
      selector: cssPath(element),
      options: element.tagName === 'SELECT'
        ? Array.from(element.options).map(option => ({
          label: normalize(option.label || option.innerText),
          value: option.value,
          selected: option.selected,
          disabled: option.disabled,
        }))
        : [],
      value: element.tagName === 'SELECT' ? element.value : ('value' in element ? element.value : null),
    });
    const documentTypeCandidates = labelElement && documentTypeScope
      ? Array.from(documentTypeScope.querySelectorAll(candidateSelector))
        .filter(element => isVisible(element))
        .map(describeControl)
      : [];
    const committedDocumentTypes = documentTypeScope
      ? Array.from(documentTypeScope.querySelectorAll('button[aria-label]'))
        .filter(element => /^remove item\b/i.test(normalize(element.getAttribute('aria-label'))))
        .map(element => {
          const valueMatch = (element.getAttribute('aria-label') || '').match(/:\s*['"]([^'"]+)['"]/);
          return {
            label: normalize(element.parentElement?.innerText || '')
              .replace(/\bdocument type\b/gi, '')
              .replace(/\bremove item\b/gi, '')
              .trim() || null,
            value: valueMatch ? valueMatch[1] : null,
            evidence: 'selected token exposes a Remove item control',
          };
        })
      : [];
    const instructionText = body.innerText || '';
    const instructionMatch = instructionText.match(/supported formats?\s*:\s*([^.\n]+\.?)/i);
    const instructionFormatText = instructionMatch
      ? normalize(instructionMatch[1].replace(/\s*\(\s*max\s*:[^)]+\)/i, '').replace(/\.$/, ''))
      : null;
    const instructionMaxSizeMatch = instructionText.match(/\bmax\s*:\s*([\d.]+\s*(?:KB|MB|GB))/i);
    const documentInstructions = {
      supportedFormatText: instructionFormatText,
      maxFileSizeText: instructionMaxSizeMatch ? normalize(instructionMaxSizeMatch[1]) : null,
      acceptedFormats: instructionFormatText
        ? instructionFormatText.split(/\s*,\s*|\s*\/\s*/).map(value => value.trim()).filter(Boolean)
        : [],
    };
    const fileInputs = Array.from(body.querySelectorAll('input[type="file"]')).map((input, index) => {
      const explicitLabels = input.labels ? Array.from(input.labels).map(label => normalize(label.innerText)).filter(Boolean) : [];
      const labelledBy = normalize(textForIds(input.getAttribute('aria-labelledby')));
      let semanticContainer = null;
      let fieldComponentContainer = null;
      let fieldComponentClass = null;
      let fallbackFieldComponentContainer = null;
      let fallbackFieldComponentClass = null;
      const requiredEkycKeys = new Set(['poi_gov_id_front', 'poi_gov_id_back', 'por_document']);
      const genericComponentTypes = new Set([
        'button', 'checkbox', 'columns', 'container', 'content', 'datagrid', 'datetime',
        'customfilecomponent', 'contact_file', 'editgrid', 'email', 'fieldset', 'file', 'hidden', 'htmlelement', 'number',
        'panel', 'password', 'phonenumber', 'radio', 'select', 'signature', 'survey',
        'table', 'textarea', 'textfield', 'unknown', 'url', 'well',
      ]);
      const inputName = (input.getAttribute('name') || '').toLowerCase();
      for (let ancestor = input.parentElement, depth = 0; ancestor && ancestor !== body && depth < 12; ancestor = ancestor.parentElement, depth += 1) {
        const componentClasses = Array.from(ancestor.classList || [])
          .filter(className => /^formio-component-(?!container$)[a-z0-9_]+$/i.test(className));
        const requiredComponent = componentClasses.find(className =>
          requiredEkycKeys.has(className.replace(/^formio-component-/, '').toLowerCase()));
        const namedComponent = componentClasses.find(className =>
          inputName.includes(className.replace(/^formio-component-/, '').toLowerCase()));
        const keyedComponent = namedComponent || componentClasses.find(className =>
          !genericComponentTypes.has(className.replace(/^formio-component-/, '')));
        if (!fallbackFieldComponentContainer && keyedComponent) {
          fallbackFieldComponentContainer = ancestor;
          fallbackFieldComponentClass = keyedComponent;
        }
        if (requiredComponent) {
          fieldComponentContainer = ancestor;
          fieldComponentClass = requiredComponent;
          break;
        }
        if (!semanticContainer && ancestor.matches('label, fieldset, [role="group"], [role="region"], [aria-labelledby], [data-testid], [class*="upload" i], [class*="document" i]')) {
          semanticContainer = ancestor;
        }
        if (semanticContainer && fallbackFieldComponentContainer) break;
      }
      if (!fieldComponentContainer && fallbackFieldComponentContainer) {
        fieldComponentContainer = fallbackFieldComponentContainer;
        fieldComponentClass = fallbackFieldComponentClass;
      }
      const nearbyAncestors = [];
      for (let ancestor = input.parentElement, depth = 0; ancestor && ancestor !== body && depth < 8; ancestor = ancestor.parentElement, depth += 1) {
        const text = normalize(ancestor.innerText || '');
        nearbyAncestors.push({
          tag: ancestor.tagName.toLowerCase(),
          id: ancestor.id || null,
          className: typeof ancestor.className === 'string' ? ancestor.className.slice(0, 120) || null : null,
          role: ancestor.getAttribute('role'),
          text: text.slice(0, 240) || null,
        });
      }
      const accept = input.getAttribute('accept');
      const acceptedFormats = accept
        ? accept.split(',').map(value => value.trim()).filter(Boolean)
        : [];
      const sectionText = semanticContainer ? normalize(semanticContainer.innerText) : '';
      const supportedFormatMatch = sectionText.match(/supported format\s*:\s*([^\n]+)/i);
      const maxSizeMatch = sectionText.match(/max\s*:\s*([\d.]+\s*(?:KB|MB|GB))/i);
      const requiredByClass = Array.from({ length: 8 }, (_, depth) => {
        let ancestor = input;
        for (let index = 0; index < depth && ancestor; index += 1) ancestor = ancestor.parentElement;
        return ancestor;
      }).some(ancestor => ancestor?.classList.contains('required'));
      const componentClass = fieldComponentClass;
      const form = input.form;
      const constraints = {
        accept: accept || null,
        acceptedFormats,
        acceptedFormatsFromInstructions: documentInstructions.acceptedFormats,
        supportedFormatText: supportedFormatMatch ? supportedFormatMatch[1].trim() : null,
        maxFileSizeText: maxSizeMatch
          ? maxSizeMatch[1].replace(/\s+/g, ' ').trim()
          : documentInstructions.maxFileSizeText,
        multiple: input.multiple,
        required: input.required || input.getAttribute('aria-required') === 'true' || requiredByClass,
        requiredStatus: input.required
          ? 'required-by-native-attribute'
          : input.getAttribute('aria-required') === 'true'
            ? 'required-by-aria'
            : requiredByClass
              ? 'required-by-rendered-required-class'
            : 'unknown-not-marked-required',
        requiredEvidence: requiredByClass ? 'required class observed on a rendered upload-control ancestor' : null,
        disabled: input.disabled || input.getAttribute('aria-disabled') === 'true',
      };
      return {
        index,
        id: input.id || null,
        name: input.name || null,
        selector: cssPath(input),
        visible: isVisible(input),
        labels: explicitLabels,
        ariaLabel: input.getAttribute('aria-label'),
        labelledBy: labelledBy || null,
        associatedSection: semanticContainer
          ? normalize(semanticContainer.innerText).slice(0, 500) || null
          : null,
        associationSource: explicitLabels.length
          ? 'native-label-association'
          : labelledBy
            ? 'aria-labelledby'
            : semanticContainer
              ? 'nearest-semantic-or-upload-container'
              : 'no-explicit-label-or-semantic-container-found',
        fieldComponent: componentClass ? componentClass.replace(/^formio-component-/, '') : null,
        fieldComponentSelector: componentClass ? `.${componentClass}` : null,
        fieldComponentAssociationSource: componentClass && requiredEkycKeys.has(componentClass.replace(/^formio-component-/, '').toLowerCase())
          ? 'required-Form.io-field-key'
          : componentClass
            ? 'Form.io-component-class'
            : 'not-associated-with-a-stable-Form.io-key',
        form: form ? { id: form.id || null, name: form.getAttribute('name') || null } : null,
        nearbyAncestors,
        constraints,
      };
    });
    const collectVisibleOptions = () => Array.from(body.querySelectorAll('[role="option"], option, [role="menuitem"]'))
      .filter(isVisible)
      .map(option => ({
        label: normalize(option.innerText || option.getAttribute('aria-label')) || null,
        value: option.getAttribute('data-value') || (option.tagName === 'OPTION' ? option.value : null),
        selected: option.getAttribute('aria-selected') === 'true' || option.selected === true,
        disabled: option.getAttribute('aria-disabled') === 'true' || option.disabled === true,
        role: option.getAttribute('role') || 'option',
      }));
    return {
      documentTypeLabelObserved: Boolean(labelElement),
      documentTypeLabelText: labelElement ? normalize(labelElement.innerText || labelElement.getAttribute('aria-label')) : null,
      documentTypeScopeText: documentTypeScope ? normalize(documentTypeScope.innerText).slice(0, 500) : null,
      documentTypeCandidates,
      committedDocumentTypes,
      triggerSelector: trigger ? cssPath(trigger) : null,
      triggerKind: trigger ? `${trigger.tagName.toLowerCase()}${trigger.getAttribute('role') ? `[role=${trigger.getAttribute('role')}]` : ''}` : null,
      initiallyVisibleOptions: collectVisibleOptions(),
      documentInstructions,
      fileInputs,
    };
  });

  let options = inspection.initiallyVisibleOptions.filter(option => option.label || option.value);
  if (!options.length) {
    options = inspection.documentTypeCandidates.flatMap(control => control.options || [])
      .filter(option => option.label || option.value);
  }
  let openedForInspection = false;
  let inspectionResult = 'Document Type options were read from controls already rendered in the UI.';
  if (!options.length && inspection.triggerSelector && inspection.triggerKind !== 'select') {
    const trigger = page.locator(inspection.triggerSelector);
    if (await trigger.count() === 1 && await trigger.isVisible()) {
      await trigger.click();
      openedForInspection = true;
      const observed = new Map();
      let previousScrollState = null;
      for (let scan = 0; scan < 20; scan += 1) {
        const current = await page.locator('body').evaluate(body => {
          const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
          const isVisible = element => {
            const style = window.getComputedStyle(element);
            return element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          };
          const options = Array.from(body.querySelectorAll('[role="option"], option, [role="menuitem"]'))
            .filter(isVisible)
            .map(option => ({
              label: normalize(option.innerText || option.getAttribute('aria-label')) || null,
              value: option.getAttribute('data-value') || (option.tagName === 'OPTION' ? option.value : null),
              selected: option.getAttribute('aria-selected') === 'true' || option.selected === true,
              disabled: option.getAttribute('aria-disabled') === 'true' || option.disabled === true,
              role: option.getAttribute('role') || 'option',
            }))
            .filter(option => option.label || option.value);
          const scrollContainers = Array.from(body.querySelectorAll('[role="listbox"], [role="menu"], [class*="menu" i], [class*="list" i]'))
            .filter(isVisible)
            .map(element => {
              const style = window.getComputedStyle(element);
              return {
                element,
                top: element.scrollTop,
                height: element.scrollHeight,
                clientHeight: element.clientHeight,
                canScroll: /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight,
              };
            })
            .filter(item => item.canScroll);
          const scrollTarget = scrollContainers[scrollContainers.length - 1];
          const state = scrollTarget
            ? { top: scrollTarget.top, height: scrollTarget.height, clientHeight: scrollTarget.clientHeight }
            : null;
          if (scrollTarget) scrollTarget.element.scrollTop = Math.min(scrollTarget.top + scrollTarget.clientHeight, scrollTarget.height);
          return { options, state };
        });
        for (const option of current.options) {
          const key = `${option.value ?? ''}\u0000${option.label ?? ''}`;
          observed.set(key, option);
        }
        const state = current.state;
        if (!state || state.top + state.clientHeight >= state.height || JSON.stringify(state) === previousScrollState) break;
        previousScrollState = JSON.stringify(state);
        await page.waitForTimeout(100);
      }
      options = [...observed.values()];
      inspectionResult = options.length
        ? 'Opened the identified Document Type control and collected rendered semantic options without selecting one.'
        : 'Opened the identified Document Type control, but no semantic options were exposed.';
      await page.keyboard.press('Escape');
    } else {
      inspectionResult = 'The Document Type trigger could not be uniquely located and opened safely.';
    }
  } else if (!inspection.documentTypeLabelObserved) {
    inspectionResult = 'No rendered Document Type label was found; no control was opened.';
  } else if (!inspection.triggerSelector) {
    inspectionResult = 'The Document Type label was observed, but no associated interactive control was found.';
  }

  const currentValues = await page.locator('body').evaluate(body => {
    const selectorValues = selectors => selectors.map(selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      return {
        selector,
        value: 'value' in element ? element.value : element.innerText || null,
      };
    }).filter(Boolean);
    return selectorValues([
      ...Array.from(body.querySelectorAll('input[type="file"]')).map(input => {
        if (input.id) return `#${CSS.escape(input.id)}`;
        if (input.name) return `input[type="file"][name="${CSS.escape(input.name)}"]`;
        return null;
      }).filter(Boolean),
    ]);
  });
  const committedDocumentTypesAfterInspection = await page.locator('body').evaluate(body =>
    Array.from(body.querySelectorAll('button[aria-label]'))
      .filter(element => /^remove item\b/i.test(element.getAttribute('aria-label') || ''))
      .map(element => {
        const valueMatch = (element.getAttribute('aria-label') || '').match(/:\s*['"]([^'"]+)['"]/);
        return {
          label: (element.parentElement?.innerText || '')
            .replace(/\s+/g, ' ')
            .replace(/\bdocument type\b/gi, '')
            .replace(/\bremove item\b/gi, '')
            .trim() || null,
          value: valueMatch ? valueMatch[1] : null,
        };
      }));

  return {
    ...inspection,
    options,
    committedDocumentTypesAfterInspection,
    committedSelectionPreserved: JSON.stringify(inspection.committedDocumentTypes.map(({ label, value }) => ({ label, value })))
      === JSON.stringify(committedDocumentTypesAfterInspection),
    openedForInspection,
    result: inspectionResult,
    fileValuesAfterInspection: currentValues,
    uploadAttempted: false,
    uploadOutcome: 'not-attempted-no-approved-fixture',
    fileNameVisible: false,
    uploadAccepted: false,
    continueClicked: false,
    fixture: findProjectEkycFixtures(process.cwd()),
    uatSyntheticUploadPermission: 'not-established-from-project-or-rendered-UI',
  };
}

module.exports = { findProjectEkycFixtures, inspectEkycUpload };
