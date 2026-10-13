function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function inspectCountrySelection(control) {
  return control.evaluate(element => {
    const visible = candidate => {
      const style = window.getComputedStyle(candidate);
      return candidate.getClientRects().length > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden';
    };
    const normalizeText = value => String(value || '')
      .replace(/\bremove item\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const tagName = element.tagName.toLowerCase();
    const selectedOption = tagName === 'select' ? element.selectedOptions[0] : null;
    const hiddenValue = element.querySelector('input[type="hidden"]');
    const selectedNode = element.querySelector(
      '[aria-selected="true"], [data-selected="true"], .choices__list--single .choices__item, .choices__list--multiple .choices__item[data-item]',
    );
    let autocompleteInput = Array.from(element.querySelectorAll('input:not([type="hidden"])'))
      .find(visible);
    let ancestor = element.parentElement;
    for (let depth = 0; !autocompleteInput && ancestor && depth < 4; depth += 1, ancestor = ancestor.parentElement) {
      const associatedInputs = Array.from(ancestor.querySelectorAll('input[type="text"], input[type="search"]'))
        .filter(visible);
      if (associatedInputs.length === 1) autocompleteInput = associatedInputs[0];
      else if (associatedInputs.length > 1) break;
    }
    const selectedValue = selectedOption?.value
      || hiddenValue?.value
      || selectedNode?.getAttribute('data-value')
      || selectedNode?.getAttribute('value')
      || element.getAttribute('data-value')
      || element.getAttribute('aria-valuetext')
      || null;
    const selectedLabel = normalizeText(selectedOption?.label || selectedOption?.textContent)
      || normalizeText(selectedNode?.innerText || selectedNode?.getAttribute('aria-label'))
      || normalizeText(element.getAttribute('aria-valuetext'))
      || null;
    const placeholderText = normalizeText(element.getAttribute('placeholder')
      || (tagName === 'select' ? element.options[0]?.textContent : ''));
    const placeholderOnly = !selectedValue || !selectedLabel
      || (selectedOption && (!selectedOption.value || selectedOption.disabled))
      || /^(select|choose)(\s|$)/i.test(selectedLabel);
    const displayedText = normalizeText(selectedLabel || element.innerText || element.value);

    return {
      tagName,
      role: element.getAttribute('role'),
      id: element.id || null,
      name: element.getAttribute('name'),
      displayedText: displayedText || null,
      selectedValue: selectedValue ? String(selectedValue) : null,
      selectedLabel: selectedLabel || null,
      hasCommittedSelection: Boolean(selectedValue && selectedLabel && !placeholderOnly),
      placeholderOnly,
      placeholderText: placeholderText || null,
      typedUncommittedText: autocompleteInput?.value || null,
      ariaInvalid: element.getAttribute('aria-invalid') === 'true',
      validationMessage: normalizeText(element.validationMessage),
      enabled: !element.disabled && element.getAttribute('aria-disabled') !== 'true',
    };
  });
}

async function getVisibleCountryOptions(page, control) {
  const controlInfo = await control.evaluate(element => ({
    tagName: element.tagName.toLowerCase(),
    controls: (element.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean),
  }));
  if (controlInfo.tagName === 'select') {
    return control.locator('option').evaluateAll(options => options.map(option => ({
      label: (option.label || option.textContent || '').replace(/\s+/g, ' ').trim(),
      value: option.value,
      selected: option.selected,
      disabled: option.disabled,
      source: 'native-select-option',
    })).filter(option => option.label));
  }

  const controlledList = controlInfo.controls.length
    ? page.locator(controlInfo.controls.map(id => `[id=${JSON.stringify(id)}]`).join(', '))
    : null;
  const optionLocator = controlledList
    ? controlledList.locator('[role="option"]:visible, .choices__item--choice:visible')
    : page.locator('[role="option"]:visible, .choices__item--choice:visible');
  return optionLocator.evaluateAll(options => options.map(option => ({
    label: (option.innerText || option.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
    value: option.getAttribute('data-value') || option.getAttribute('value'),
    selected: option.getAttribute('aria-selected') === 'true',
    disabled: option.getAttribute('aria-disabled') === 'true'
      || option.classList.contains('is-disabled'),
    source: option.getAttribute('role') === 'option' ? 'visible-role-option' : 'visible-choices-option',
  })).filter(option => option.label));
}

function mergeOptions(...lists) {
  const merged = new Map();
  for (const option of lists.flat()) {
    const key = `${option.value || ''}\u0000${normalize(option.label).toLowerCase()}`;
    if (option.label) merged.set(key, option);
  }
  return [...merged.values()];
}

async function collectAvailableCountryOptions(page, control, { maxScrolls = 100 } = {}) {
  let options = [];
  let scrolls = 0;
  let reachedEnd = false;
  for (; scrolls < maxScrolls; scrolls += 1) {
    const current = await getVisibleCountryOptions(page, control);
    options = mergeOptions(options, current);

    const scrollResult = await control.evaluate(element => {
      const controlledIds = (element.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
      const listRoots = controlledIds.map(id => document.getElementById(id)).filter(Boolean);
      if (!listRoots.length) {
        listRoots.push(...Array.from(document.querySelectorAll('[role="listbox"], .choices__list--dropdown'))
          .filter(root => root.getClientRects().length > 0));
      }
      const loadMoreButton = () => listRoots.flatMap(root => Array.from(root.querySelectorAll('button, [role="button"]')))
        .find(button => button.getClientRects().length > 0
          && !button.disabled
          && /load more|show more|more countries/i.test(button.innerText || button.getAttribute('aria-label') || ''));
      let node = controlledIds.map(id => document.getElementById(id)).find(Boolean);
      if (!node) node = listRoots.find(root => root.getClientRects().length > 0) || null;
      const isScrollable = candidate => candidate.scrollHeight > candidate.clientHeight + 2
        && ['auto', 'scroll'].includes(window.getComputedStyle(candidate).overflowY);
      while (node && !isScrollable(node)) node = node.parentElement;
      if (!node) {
        const option = controlledIds.flatMap(id => {
          const list = document.getElementById(id);
          return list ? Array.from(list.querySelectorAll('[role="option"], .choices__item--choice')) : [];
        }).find(candidate => candidate.getClientRects().length > 0);
        node = option?.parentElement || null;
        while (node && !isScrollable(node)) node = node.parentElement;
      }
      if (!node) {
        const loadMore = loadMoreButton();
        if (loadMore) {
          loadMore.click();
          return { scrolled: true, atEnd: false, loadedMore: true };
        }
        return { scrolled: false, atEnd: true };
      }
      if (node.scrollTop + node.clientHeight >= node.scrollHeight - 2) {
        const loadMore = loadMoreButton();
        if (loadMore) {
          loadMore.click();
          return { scrolled: true, atEnd: false, loadedMore: true };
        }
        return { scrolled: false, atEnd: true };
      }
      node.scrollTop = Math.min(node.scrollTop + Math.max(node.clientHeight * 0.8, 100), node.scrollHeight);
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
      return { scrolled: true, atEnd: false };
    });
    if (!scrollResult.scrolled) {
      reachedEnd = scrollResult.atEnd === true;
      break;
    }
    await page.waitForTimeout(scrollResult.loadedMore ? 300 : 100);
  }
  options = mergeOptions(options, await getVisibleCountryOptions(page, control));
  return {
    options,
    scrolls: Math.min(scrolls + 1, maxScrolls),
    reachedEnd,
    complete: reachedEnd,
  };
}

async function findScopedCountrySearchInput(control) {
  let ancestor = control;
  for (let depth = 0; depth < 5; depth += 1) {
    ancestor = ancestor.locator('xpath=..');
    const inputs = ancestor.locator('input[type="text"]:visible, input[type="search"]:visible');
    if (await inputs.count() === 1) {
      const locator = inputs;
      const attributes = await locator.evaluate(input => ({
        id: input.id || null,
        name: input.getAttribute('name'),
        type: input.getAttribute('type'),
        role: input.getAttribute('role'),
        ariaLabel: input.getAttribute('aria-label'),
        placeholder: input.getAttribute('placeholder'),
        value: input.value,
      }));
      return { locator, attributes };
    }
  }
  return null;
}

async function restoreCountrySearch(page, searchInputInfo, originalValue) {
  if (searchInputInfo) {
    await searchInputInfo.locator.fill(originalValue || '');
    searchInputInfo.attributes.value = originalValue || '';
  }
  await page.keyboard.press('Escape');
}

async function scrollCountryMenuToStart(control) {
  await control.evaluate(element => {
    const ids = (element.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
    let node = ids.map(id => document.getElementById(id)).find(Boolean);
    if (!node) {
      node = Array.from(document.querySelectorAll('[role="listbox"], .choices__list--dropdown'))
        .find(root => root.getClientRects().length > 0) || null;
    }
    const isScrollable = candidate => candidate.scrollHeight > candidate.clientHeight + 2
      && ['auto', 'scroll'].includes(window.getComputedStyle(candidate).overflowY);
    while (node && !isScrollable(node)) node = node.parentElement;
    if (node) {
      node.scrollTop = 0;
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
  });
}

function isMeaningfulCountryOption(option) {
  const label = normalize(option.label);
  return Boolean(label)
    && option.disabled !== true
    && !/^(?:select|choose|please select|please choose|type to search|search|other|unknown|not listed|n\/?a)(?:\b|$)/i.test(label);
}

async function selectApprovedCountry(page, control, approvedCountry, { allowFirstMeaningfulFallback = false } = {}) {
  const before = await inspectCountrySelection(control);
  if (before.hasCommittedSelection && !before.ariaInvalid && !before.validationMessage) {
    return {
      status: 'prefilled-preserved',
      before,
      options: [],
      selected: before,
      validationUpdated: false,
      reason: 'A committed country selection was already present; it was preserved.',
    };
  }

  await control.click();
  const initialDiscovery = await collectAvailableCountryOptions(page, control);
  const initialOptions = initialDiscovery.options;
  let options = initialOptions;
  let searchValue = null;
  let searchInputInfo = null;
  let originalSearchValue = '';
  const approvedOptionVisible = () => options.some(option => isMeaningfulCountryOption(option)
    && normalize(option.label).toLowerCase() === normalize(approvedCountry).toLowerCase());
  if (approvedCountry && !approvedOptionVisible()) {
    searchInputInfo = await findScopedCountrySearchInput(control);
    originalSearchValue = searchInputInfo?.attributes.value || '';
    if (searchInputInfo) {
      searchValue = approvedCountry;
      await searchInputInfo.locator.fill(approvedCountry);
      try {
        await page.getByRole('option', { name: approvedCountry, exact: true })
          .waitFor({ state: 'visible', timeout: 5_000 });
      } catch (error) {
        if (!(error.name === 'TimeoutError' || error.name === 'PlaywrightTimeoutError')) throw error;
      }
      const searched = await collectAvailableCountryOptions(page, control);
      options = mergeOptions(initialOptions, searched.options);
      searchInputInfo.attributes.value = approvedCountry;
      searchInputInfo.attributes.optionScanScrolls = searched.scrolls;
      searchInputInfo.attributes.optionScanComplete = searched.complete;
    }
  }
  if (!initialDiscovery.complete) {
    await restoreCountrySearch(page, searchInputInfo, originalSearchValue);
    return {
      status: 'option-scan-incomplete',
      before,
      initialOptions,
      initialOptionScanScrolls: initialDiscovery.scrolls,
      optionScanComplete: false,
      options,
      searchValue,
      searchInput: searchInputInfo?.attributes || null,
      selected: await inspectCountrySelection(control),
      validationUpdated: false,
      reason: `Country option scanning did not reach the end within ${initialDiscovery.scrolls} scroll/load actions; no fallback was selected.`,
    };
  }
  if (!options.length) {
    await restoreCountrySearch(page, searchInputInfo, originalSearchValue);
    return {
      status: 'missing-visible-options',
      before,
      initialOptions,
      initialOptionScanScrolls: initialDiscovery.scrolls,
      optionScanComplete: true,
      options,
      searchValue,
      searchInput: searchInputInfo?.attributes || null,
      selected: await inspectCountrySelection(control),
      validationUpdated: false,
      reason: 'Opening the Country control exposed no selectable options.',
    };
  }

  let matches = approvedCountry
    ? options.filter(option => isMeaningfulCountryOption(option)
      && normalize(option.label).toLowerCase() === normalize(approvedCountry).toLowerCase())
    : [];
  let fallbackUsed = false;
  if (matches.length !== 1 && allowFirstMeaningfulFallback) {
    const fallback = options.find(isMeaningfulCountryOption);
    matches = fallback ? [fallback] : [];
    fallbackUsed = Boolean(fallback);
  }
  if (matches.length !== 1) {
    await restoreCountrySearch(page, searchInputInfo, originalSearchValue);
    return {
      status: !approvedCountry ? 'approved-country-unavailable' : 'approved-country-not-found',
      before,
      initialOptions,
      initialOptionScanScrolls: initialDiscovery.scrolls,
      optionScanComplete: initialDiscovery.complete,
      options,
      searchValue,
      searchInput: searchInputInfo?.attributes || null,
      selected: await inspectCountrySelection(control),
      validationUpdated: false,
      reason: !approvedCountry
        ? 'Country options were completely inspected, but no approved residence-country value is configured and no fallback was authorized.'
        : matches.length
        ? `More than one visible option matches approved country "${approvedCountry}".`
        : allowFirstMeaningfulFallback
          ? 'No approved country matched and no enabled meaningful country option was available for the authorized QA fallback.'
          : `No enabled visible option matches approved country "${approvedCountry}".`,
    };
  }

  const match = matches[0];
  if (fallbackUsed) {
    searchInputInfo = searchInputInfo || await findScopedCountrySearchInput(control);
    if (searchInputInfo) {
      originalSearchValue = searchInputInfo.attributes.value || '';
      await searchInputInfo.locator.fill(match.label);
      try {
        await page.getByRole('option', { name: match.label, exact: true })
          .waitFor({ state: 'visible', timeout: 5_000 });
      } catch (error) {
        if (!(error.name === 'TimeoutError' || error.name === 'PlaywrightTimeoutError')) throw error;
      }
      options = mergeOptions(options, await getVisibleCountryOptions(page, control));
      searchInputInfo.attributes.value = match.label;
    } else {
      await scrollCountryMenuToStart(control);
      await page.waitForTimeout(100);
    }
  }
  if (match.source !== 'native-select-option' && searchInputInfo) {
    const exactOption = page.getByRole('option', { name: match.label, exact: true });
    if (!await exactOption.isVisible().catch(() => false)) {
      await restoreCountrySearch(page, searchInputInfo, originalSearchValue);
      return {
        status: 'visible-option-not-actionable',
        before,
        initialOptions,
        initialOptionScanScrolls: initialDiscovery.scrolls,
        optionScanComplete: initialDiscovery.complete,
        options,
        searchValue,
        searchInput: searchInputInfo.attributes,
        selected: await inspectCountrySelection(control),
        validationUpdated: false,
        reason: `The actual option "${match.label}" could not be made visible in the dropdown for verified selection.`,
      };
    }
  }
  if (match.source === 'native-select-option') {
    await control.selectOption(match.value
      ? { value: match.value }
      : { label: match.label });
  } else {
    const roleOption = page.getByRole('option', { name: match.label, exact: true });
    if (await roleOption.count() === 1) {
      await roleOption.click();
    } else {
      const choiceOptions = page.locator('.choices__item--choice:visible');
      let choice = null;
      for (let index = 0; index < await choiceOptions.count(); index += 1) {
        if (normalize(await choiceOptions.nth(index).innerText()) === normalize(match.label)) {
          if (choice) {
            choice = null;
            break;
          }
          choice = choiceOptions.nth(index);
        }
      }
      if (!choice) {
        await restoreCountrySearch(page, searchInputInfo, originalSearchValue);
        return {
          status: 'visible-option-not-actionable',
          before,
          initialOptions,
          initialOptionScanScrolls: initialDiscovery.scrolls,
          options,
          searchValue,
          searchInput: searchInputInfo?.attributes || null,
          selected: await inspectCountrySelection(control),
          validationUpdated: false,
          reason: 'The observed option was not uniquely actionable through its rendered option control.',
        };
      }
      await choice.click();
    }
  }

  const selected = await inspectCountrySelection(control);
  const verified = selected.hasCommittedSelection
    && normalize(selected.selectedLabel).toLowerCase() === normalize(match.label).toLowerCase()
    && (!match.value || selected.selectedValue === String(match.value)
      || normalize(selected.selectedValue).toLowerCase() === normalize(match.label).toLowerCase())
    && !selected.ariaInvalid
    && !selected.validationMessage;
  return {
    status: verified ? 'selected-and-verified' : 'selection-not-verified',
    before,
    initialOptions,
    initialOptionScanScrolls: initialDiscovery.scrolls,
    options,
    searchValue,
    searchInput: searchInputInfo?.attributes || null,
    approvedCountry: approvedCountry || null,
    selectedBy: fallbackUsed ? 'first-enabled-meaningful-ui-option-qa-fallback' : 'approved-residence-country',
    selectedOption: {
      label: selected.selectedLabel,
      value: selected.selectedValue,
    },
    optionScanComplete: initialDiscovery.complete,
    selected,
    validationUpdated: selected.ariaInvalid !== before.ariaInvalid
      || selected.validationMessage !== before.validationMessage,
    reason: verified
      ? fallbackUsed
        ? 'The first enabled meaningful option from the complete UI option scan was committed to Country.'
        : 'The exact visible approved option is committed to the Country control.'
      : 'Selection was not confirmed as a committed Country value.',
  };
}

module.exports = {
  getVisibleCountryOptions,
  inspectCountrySelection,
  selectApprovedCountry,
};
