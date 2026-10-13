const { expect, errors } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const {
  FORM_CONTROLS,
  inspectDynamicForm,
  discoverDropdownOptions,
  investigateConditionalFields,
  locateField,
} = require('./formInspector');
const { inspectCountrySelection, selectApprovedCountry } = require('./countryInspector');
const { isEmptyFieldValue, valuesMatch } = require('./formDecision');
const { inspectEkycUpload } = require('./uploadInspector');

const SENSITIVE_KEY = /password|token|secret|authorization|cookie|session|email|phone|mobile|first.?name|last.?name|full.?name|address|birth|dob|income|wealth|assets|net.?worth/i;
const DECISION_BLOCKER = /\b(consent|agree|accept|declar(?:e|ation)|certif(?:y|ication)|true and correct|politically exposed|pep\b|source of (?:funds|wealth|income)|tax residency|tax resident|sanctions|investment(?: objective| experience)?|occupation|employer|income|assets|net worth|financial commitment)\b/i;
const FINANCIAL_DECLARATION_FIELD = /^(?:annual income(?:\s*\(USD\))?|source of wealth)$/i;
const EXPLICIT_DECISION_TEXT = /\b(?:i\s+(?:agree|accept|declare|certify)|i have read|consent to|acknowledge that|true and correct|politically exposed|pep\b|sanctions)\b/i;
const TEST_RESIDENCE_COUNTRY = String(process.env.TEST_RESIDENCE_COUNTRY || '').trim();
const ONBOARDING_FORM_WAIT_MS = 120_000;
const USER_DECISION_WAIT_MS = 120_000;
const MAX_EKYC_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const REQUIRED_EKYC_UPLOADS = [
  { key: 'poi_gov_id_front', label: 'Government ID front' },
  { key: 'poi_gov_id_back', label: 'Government ID back' },
  { key: 'por_document', label: 'Proof of residence' },
];

function uploadBlocker(field, reason, extra = {}) {
  return {
    status: 'blocked',
    failedField: field.label,
    fieldKey: field.key,
    reason,
    ...extra,
  };
}

function bytesForLimit(value) {
  const match = String(value || '').match(/([\d.]+)\s*(KB|MB|GB)/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[match[2].toUpperCase()];
  return Number.isFinite(amount) ? Math.floor(amount * multiplier) : null;
}

function isFinancialDeclarationField(field) {
  return FINANCIAL_DECLARATION_FIELD.test((field.label || '').replace(/\s*\*\s*$/, '').trim());
}

function unresolvedFinancialDeclarations(form) {
  return form.fields.filter(field => isFinancialDeclarationField(field)
    && (field.required || field.ariaInvalid || field.validationMessage)
    && (isEmptyFieldValue(field) || field.ariaInvalid || field.validationMessage));
}

function declarationOptions(form, field) {
  const key = field.id || field.name || `${field.controlType}:${field.label || field.index}`;
  const discovery = form.dropdownOptionDiscovery?.find(item => item.field === key);
  return (discovery?.options || field.options || [])
    .filter(option => option.disabled !== true)
    .filter(option => option.value !== '' && !/^(?:select|choose|please select|please choose)$/i.test(option.label || ''))
    .map(option => option.label)
    .filter(Boolean);
}

async function waitForUserDeclarations(page, form, timeoutMs = USER_DECISION_WAIT_MS) {
  let latestForm = form;
  let unresolved = unresolvedFinancialDeclarations(latestForm);
  if (!unresolved.length) return { completed: true, form: latestForm, fields: [] };

  console.log('[USER ACTION] Complete the required personal-declaration fields in the headed browser. The test will not choose or enter answers.');
  for (const field of unresolved) {
    const options = declarationOptions(latestForm, field);
    console.log(`  ${field.label}: available options: ${options.length ? options.join(', ') : 'not exposed'}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(Math.min(250, deadline - Date.now()));
    latestForm = await inspectDynamicForm(page);
    unresolved = unresolvedFinancialDeclarations(latestForm);
    if (!unresolved.length) {
      return {
        completed: true,
        form: latestForm,
        fields: form.fields.filter(isFinancialDeclarationField).map(field => ({
          field: field.label,
          status: 'user-value-verified',
        })),
      };
    }
  }

  return {
    completed: false,
    form: latestForm,
    fields: unresolved.map(field => ({
      field: field.label || field.id || field.name,
      availableOptions: declarationOptions(latestForm, field),
      reason: 'A truthful user decision is required; no answer was selected or entered by automation.',
    })),
    reason: 'Required personal-declaration fields were not completed by the user before the manual-decision timeout.',
  };
}

function selectedOptionMatches(field, option) {
  const expected = [option.label, option.value]
    .filter(value => value !== null && value !== undefined && value !== '')
    .map(value => String(value).trim().toLowerCase());
  const observedValues = [
    ...(Array.isArray(field.currentValue) ? field.currentValue : [field.currentValue]),
    field.displayedText,
    ...(field.committedSelections || []).flatMap(selection => [selection.label, selection.value]),
  ].filter(value => value !== null && value !== undefined && value !== '')
    .map(value => String(value).trim().toLowerCase());
  return observedValues.some(value => expected.includes(value))
    || (field.options || []).some(candidate => candidate.selected === true
      && [candidate.label, candidate.value]
        .filter(value => value !== null && value !== undefined && value !== '')
        .some(value => expected.includes(String(value).trim().toLowerCase())));
}

// async function attachApprovedEkycFixture(page, inspection, projectRoot = process.cwd()) {
//   const fixtures = inspection.fixture;
//   const pngFixtures = (fixtures?.found || []).filter(filePath => /\.png$/i.test(filePath));
//   if (!fixtures?.directoryExists || pngFixtures.length === 0) {
//     const fixtureBlocker = !fixtures?.directoryExists
//       ? `The requested fixture directory ${fixtures?.directory || 'utils\\testfile'} does not exist, so no PNG is available.`
//       : `No PNG fixture was found under ${fixtures.directory}.`;
//     return uploadBlocker(
//       REQUIRED_EKYC_UPLOADS[0],
//       `${fixtureBlocker} No file was attached.`,
//       { fixtureScan: fixtures || null },
//     );
//   }
//   if (process.env.TEST_EKYC_SYNTHETIC_FIXTURE_APPROVED !== 'true') {
//     return uploadBlocker(
//       REQUIRED_EKYC_UPLOADS[0],
//       'A PNG exists, but explicit synthetic UAT fixture approval was not provided (set TEST_EKYC_SYNTHETIC_FIXTURE_APPROVED=true only after approval). No file was attached.',
//       { fixtureScan: fixtures },
//     );
//   }
//   if (pngFixtures.length !== 1) {
//     return uploadBlocker(
//       REQUIRED_EKYC_UPLOADS[0],
//       `Expected exactly one approved PNG fixture under ${fixtures.directory}; observed ${pngFixtures.length}. No file was attached.`,
//       { fixtureScan: fixtures },
//     );
//   }

//   const fixturePath = path.resolve(projectRoot, pngFixtures[0]);
//   let fixtureBytes;
//   try {
//     fixtureBytes = fs.readFileSync(fixturePath);
//   } catch (error) {
//     return uploadBlocker(
//       REQUIRED_EKYC_UPLOADS[0],
//       `The selected PNG fixture could not be read: ${error.message}. No file was attached.`,
//       { fixturePath: pngFixtures[0] },
//     );
//   }
//   const isPng = fixtureBytes.length >= 8
//     && fixtureBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
//   if (!isPng) {
//     return uploadBlocker(
//       REQUIRED_EKYC_UPLOADS[0],
//       'The selected .png file does not have a valid PNG signature. No file was attached.',
//       { fixturePath: pngFixtures[0] },
//     );
//   }
//   if (fixtureBytes.length > MAX_EKYC_FILE_SIZE_BYTES) {
//     return uploadBlocker(
//       REQUIRED_EKYC_UPLOADS[0],
//       `The PNG fixture is ${fixtureBytes.length} bytes, exceeding the 5 MB maximum. No file was attached.`,
//       { fixturePath: pngFixtures[0], sizeBytes: fixtureBytes.length },
//     );
//   }

//   const completed = [];
//   for (const field of REQUIRED_EKYC_UPLOADS) {
//     const observedInputs = (inspection.fileInputs || []).filter(input => input.fieldComponent === field.key);
//     if (observedInputs.length !== 1 || !observedInputs[0].fieldComponentSelector) {
//       return uploadBlocker(
//         field,
//         `Could not uniquely associate a file input with the Form.io field container ${field.key}; no generated DOM ID was used.`,
//         { observedMatches: observedInputs.length, completed },
//       );
//     }
//     const inputReport = observedInputs[0];
//     const acceptedFormats = [
//       ...(inputReport.constraints.acceptedFormats || []),
//       ...(inputReport.constraints.acceptedFormatsFromInstructions || []),
//     ];

//     console.log(
//   '[UPLOAD DEBUG]',
//   JSON.stringify({
//     field: field.key,
//     accept: inputReport.constraints.accept,
//     acceptedFormats: inputReport.constraints.acceptedFormats,
//     acceptedFormatsFromInstructions:
//       inputReport.constraints.acceptedFormatsFromInstructions,
//     supportedFormatText:
//       inputReport.constraints.supportedFormatText,
//     maxFileSizeText: inputReport.constraints.maxFileSizeText,
//   }, null, 2)
// );

//     // const supportsPng = acceptedFormats.some(format => /(?:^|[./])png$|image\/\*/i.test(format));
//     // if (!supportsPng) {
//     //   return uploadBlocker(
//     //     field,
//     //     `The observed file-input accept attribute and upload instructions do not confirm PNG support (observed: ${acceptedFormats.join(', ') || 'none'}). No file was attached.`,
//     //     { acceptedFormats, completed },
//     //   );
//     // }

//   //from her new version of code
// const supportedFormatText =
//   inputReport.constraints.supportedFormatText || '';

// const supportsPng = acceptedFormats.some(format =>
//   /(?:^|[./])png$|image\/\*/i.test(format)
// ) || /\bany\b/i.test(supportedFormatText);
// console.log('[PNG CHECK]', {
//   supportedFormatText,
//   supportsPng,
// });

// //till her new version of code

// if (!supportsPng) {
//   return uploadBlocker(
//     field,
//     `PNG support could not be confirmed (observed formats: ${
//       acceptedFormats.join(', ') || supportedFormatText || 'none'
//     }). No file was attached.`,
//     { acceptedFormats, completed },
//   );
// }

//     const displayedLimit = bytesForLimit(inputReport.constraints.maxFileSizeText);
//     if (!displayedLimit) {
//       return uploadBlocker(
//         field,
//         'The displayed maximum file size could not be confirmed; the upload was not attempted.',
//         { completed },
//       );
//     }
//     if (fixtureBytes.length > Math.min(displayedLimit, MAX_EKYC_FILE_SIZE_BYTES)) {
//       return uploadBlocker(
//         field,
//         `The PNG fixture exceeds this field's displayed file-size limit (${inputReport.constraints.maxFileSizeText}).`,
//         { fixturePath: pngFixtures[0], sizeBytes: fixtureBytes.length, completed },
//       );
//     }

//     const container = page.locator(inputReport.fieldComponentSelector);
//     const input = container.locator('input[type="file"]');
//     const containerCount = await container.count();
//     const inputCount = await input.count();
//     if (containerCount !== 1 || inputCount !== 1) {
//       return uploadBlocker(
//         field,
//         `The Form.io container ${field.key} resolved to ${containerCount} containers and ${inputCount} file inputs; upload stopped.`,
//         { completed },
//       );
//     }

//     try {
//       await input.setInputFiles(fixturePath);
//     } catch (error) {
//       return uploadBlocker(
//         field,
//         `Playwright could not attach the approved PNG to ${field.key}: ${error.message}`,
//         { completed },
//       );
//     }

//     const actualFile = await input.evaluate(element => {
//       const file = element.files?.[0];
//       return file ? { name: file.name, size: file.size, type: file.type } : null;
//     });
//     if (!actualFile || actualFile.name !== path.basename(fixturePath) || actualFile.size !== fixtureBytes.length) {
//       return uploadBlocker(
//         field,
//         'The file input did not retain the selected PNG with the expected name and size.',
//         { completed, actualFile },
//       );
//     }

//     const deadline = Date.now() + 5_000;
//     let visibleText = '';
//     while (Date.now() < deadline) {
//       visibleText = await container.innerText();
//       if (visibleText.includes(actualFile.name)) break;
//       await page.waitForTimeout(100);
//     }
//     if (!visibleText.includes(actualFile.name)) {
//       return uploadBlocker(
//         field,
//         `The input accepted ${actualFile.name}, but the filename was not confirmed in the visible Form.io field container.`,
//         { completed, actualFile },
//       );
//     }

//     const validationText = await container.locator('[role="alert"], [aria-live="assertive"], .invalid-feedback')
//       .filter({ visible: true })
//       .allTextContents();
//     const inputState = await input.evaluate(element => ({
//       invalid: element.getAttribute('aria-invalid') === 'true',
//       validationMessage: element.validationMessage || '',
//     }));
//     const observedValidation = [...validationText.map(text => text.replace(/\s+/g, ' ').trim()).filter(Boolean), inputState.validationMessage]
//       .filter(Boolean);
//     if (inputState.invalid || observedValidation.length) {
//       return uploadBlocker(
//         field,
//         observedValidation.join('; ') || 'The attached file is marked invalid by the field.',
//         { completed, actualFile },
//       );
//     }

//     completed.push({
//       field: field.label,
//       fieldKey: field.key,
//       status: 'attached-and-visible',
//       fileName: actualFile.name,
//       sizeBytes: actualFile.size,
//     });
//   }

//   return {
//     status: 'attached',
//     fields: completed,
//     fixturePath: pngFixtures[0],
//     fixtureUse: 'approved synthetic UAT test fixture only; not represented as a genuine identity document',
//   };
// }


async function attachApprovedEkycFixture(page, inspection, projectRoot = process.cwd()) {
  console.log('\n[UPLOAD STEP] Starting approved E-KYC fixture upload');

  const fixtures = inspection.fixture;

  // Step 1: Locate the PNG fixture in the existing fixture directory.
  console.log('[UPLOAD STEP] Checking PNG fixtures');

  const pngFixtures = (fixtures?.found || []).filter(filePath =>
    /\.png$/i.test(filePath)
  );

  console.log('[UPLOAD STEP] Fixture scan:', {
    directory: fixtures?.directory,
    directoryExists: fixtures?.directoryExists,
    pngCount: pngFixtures.length,
  });

  if (!fixtures?.directoryExists || pngFixtures.length === 0) {
    const fixtureBlocker = !fixtures?.directoryExists
      ? `The requested fixture directory ${
          fixtures?.directory || 'utils\\testfile'
        } does not exist, so no PNG is available.`
      : `No PNG fixture was found under ${fixtures.directory}.`;

    return uploadBlocker(
      REQUIRED_EKYC_UPLOADS[0],
      `${fixtureBlocker} No file was attached.`,
      { fixtureScan: fixtures || null },
    );
  }

  // Step 2: Require explicit approval for the synthetic test fixture.
  if (process.env.TEST_EKYC_SYNTHETIC_FIXTURE_APPROVED !== 'true') {
    return uploadBlocker(
      REQUIRED_EKYC_UPLOADS[0],
      'A PNG exists, but explicit synthetic UAT fixture approval was not provided. Set TEST_EKYC_SYNTHETIC_FIXTURE_APPROVED=true only after approval. No file was attached.',
      { fixtureScan: fixtures },
    );
  }

  if (pngFixtures.length !== 1) {
    return uploadBlocker(
      REQUIRED_EKYC_UPLOADS[0],
      `Expected exactly one approved PNG fixture under ${fixtures.directory}; observed ${pngFixtures.length}. No file was attached.`,
      { fixtureScan: fixtures },
    );
  }

  // Step 3: Read and validate the PNG file.
  const fixturePath = path.resolve(projectRoot, pngFixtures[0]);

  console.log('[UPLOAD STEP] Reading fixture:', fixturePath);

  let fixtureBytes;

  try {
    fixtureBytes = fs.readFileSync(fixturePath);
  } catch (error) {
    return uploadBlocker(
      REQUIRED_EKYC_UPLOADS[0],
      `The selected PNG fixture could not be read: ${error.message}. No file was attached.`,
      { fixturePath: pngFixtures[0] },
    );
  }

  const isPng = fixtureBytes.length >= 8
    && fixtureBytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  console.log('[UPLOAD STEP] PNG signature valid:', isPng);
  console.log('[UPLOAD STEP] Fixture size:', fixtureBytes.length);

  if (!isPng) {
    return uploadBlocker(
      REQUIRED_EKYC_UPLOADS[0],
      'The selected .png file does not have a valid PNG signature. No file was attached.',
      { fixturePath: pngFixtures[0] },
    );
  }

  if (fixtureBytes.length > MAX_EKYC_FILE_SIZE_BYTES) {
    return uploadBlocker(
      REQUIRED_EKYC_UPLOADS[0],
      `The PNG fixture is ${fixtureBytes.length} bytes, exceeding the 5 MB maximum. No file was attached.`,
      { fixturePath: pngFixtures[0], sizeBytes: fixtureBytes.length },
    );
  }

  const completed = [];

  // Step 4: Process each required document upload.
  for (const field of REQUIRED_EKYC_UPLOADS) {
    console.log(`\n[UPLOAD STEP] Processing: ${field.key}`);

    const observedInputs = (inspection.fileInputs || []).filter(
      input => input.fieldComponent === field.key,
    );

    console.log('[UPLOAD STEP] Matching file inputs:', observedInputs.length);

    if (
      observedInputs.length !== 1
      || !observedInputs[0].fieldComponentSelector
    ) {
      return uploadBlocker(
        field,
        `Could not uniquely associate a file input with the Form.io field container ${field.key}; no generated DOM ID was used.`,
        { observedMatches: observedInputs.length, completed },
      );
    }

    const inputReport = observedInputs[0];

    const acceptedFormats = [
      ...(inputReport.constraints.acceptedFormats || []),
      ...(inputReport.constraints.acceptedFormatsFromInstructions || []),
    ];

    console.log(
      '[UPLOAD DEBUG]',
      JSON.stringify({
        field: field.key,
        accept: inputReport.constraints.accept,
        acceptedFormats:
          inputReport.constraints.acceptedFormats,
        acceptedFormatsFromInstructions:
          inputReport.constraints.acceptedFormatsFromInstructions,
        supportedFormatText:
          inputReport.constraints.supportedFormatText,
        maxFileSizeText:
          inputReport.constraints.maxFileSizeText,
      }, null, 2),
    );

    // The UI reports "Any", and PNG support has been confirmed
    // for this application by the user.
    const supportedFormatText =
      inputReport.constraints.supportedFormatText || '';

    const supportsPng = acceptedFormats.some(format =>
      /(?:^|[./])png$|image\/\*/i.test(format)
    ) || /\bany\b/i.test(supportedFormatText);

    console.log('[PNG CHECK]', {
      supportedFormatText,
      supportsPng,
    });

    if (!supportsPng) {
      return uploadBlocker(
        field,
        `PNG support could not be confirmed (observed formats: ${
          acceptedFormats.join(', ') || supportedFormatText || 'none'
        }). No file was attached.`,
        { acceptedFormats, completed },
      );
    }

    // Step 5: Validate the maximum file size.
    console.log('[UPLOAD STEP] Before file-size validation');

    const displayedLimit = bytesForLimit(
      inputReport.constraints.maxFileSizeText,
    );

    console.log('[UPLOAD STEP] File-size limit:', displayedLimit);
    console.log('[UPLOAD STEP] Fixture size:', fixtureBytes.length);

    if (!displayedLimit) {
      return uploadBlocker(
        field,
        'The displayed maximum file size could not be confirmed; the upload was not attempted.',
        { completed },
      );
    }

    if (
      fixtureBytes.length
      > Math.min(displayedLimit, MAX_EKYC_FILE_SIZE_BYTES)
    ) {
      return uploadBlocker(
        field,
        `The PNG fixture exceeds this field's displayed file-size limit (${inputReport.constraints.maxFileSizeText}).`,
        {
          fixturePath: pngFixtures[0],
          sizeBytes: fixtureBytes.length,
          completed,
        },
      );
    }

    // Step 6: Locate the correct Form.io file input.
    console.log('[UPLOAD STEP] Before locating file input');

    const container = page.locator(
      inputReport.fieldComponentSelector,
    );

    const input = container.locator('input[type="file"]');

    const containerCount = await container.count();
    console.log('[UPLOAD STEP] Container count:', containerCount);

    const inputCount = await input.count();
    console.log('[UPLOAD STEP] File input count:', inputCount);

    if (containerCount !== 1 || inputCount !== 1) {
      return uploadBlocker(
        field,
        `The Form.io container ${field.key} resolved to ${containerCount} containers and ${inputCount} file inputs; upload stopped.`,
        { completed },
      );
    }

    // Step 7: Attach the PNG using Playwright.
    console.log('[UPLOAD STEP] Before setInputFiles');

    try {
      await input.setInputFiles(fixturePath);
      console.log('[UPLOAD STEP] After setInputFiles');
    } catch (error) {
      console.error('[UPLOAD ERROR] setInputFiles failed:', error.message);

      return uploadBlocker(
        field,
        `Playwright could not attach the approved PNG to ${field.key}: ${error.message}`,
        { completed },
      );
    }

//     // Step 8: Verify the actual file attached to the input.
//     // console.log('[UPLOAD STEP] Verifying attached file');

//     // const actualFile = await input.evaluate(element => {
//     //   const file = element.files?.[0];

//     //   return file
//     //     ? {
//     //         name: file.name,
//     //         size: file.size,
//     //         type: file.type,
//     //       }
//     //     : null;
//     // });

//     // console.log('[UPLOAD STEP] Attached file details:', actualFile);

    
// console.log('[UPLOAD STEP] Verifying attached file');

// let actualFile = null;

// try {
//   // The application may replace its file input after selection.
//   const currentInput = page
//     .locator(inputReport.fieldComponentSelector)
//     .locator('input[type="file"]');

//   actualFile = await currentInput.evaluate(
//     element => {
//       const file = element.files?.[0];

//       return file
//         ? {
//             name: file.name,
//             size: file.size,
//             type: file.type,
//           }
//         : null;
//     },
//     { timeout: 3000 },
//   );
// } catch (error) {
//   console.log(
//     '[UPLOAD DEBUG] Could not read FileList after selection:',
//     error.message,
//   );
// }

// console.log('[UPLOAD STEP] Attached file details:', actualFile);


//     if (
//       !actualFile
//       || actualFile.name !== path.basename(fixturePath)
//       || actualFile.size !== fixtureBytes.length
//     ) {
//       return uploadBlocker(
//         field,
//         'The file input did not retain the selected PNG with the expected name and size.',
//         { completed, actualFile },
//       );
//     }

//     // Step 9: Confirm the filename appears in the visible UI.
//     console.log('[UPLOAD STEP] Checking visible filename');

//     const deadline = Date.now() + 5_000;
//     let visibleText = '';

//     while (Date.now() < deadline) {
//       visibleText = await container.innerText();

//       if (visibleText.includes(actualFile.name)) {
//         break;
//       }

//       await page.waitForTimeout(100);
//     }

//     console.log('[UPLOAD STEP] Visible filename confirmed:', {
//       fileName: actualFile.name,
//       found: visibleText.includes(actualFile.name),
//     });

//     if (!visibleText.includes(actualFile.name)) {
//       return uploadBlocker(
//         field,
//         `The input accepted ${actualFile.name}, but the filename was not confirmed in the visible Form.io field container.`,
//         { completed, actualFile },
//       );
//     }



    // Step 8: Verify the file in the rendered upload component.
    console.log('[UPLOAD STEP] Verifying visible uploaded file');

    const uploadVerifyDeadline = Date.now() + 5000;
    let visibleText = '';

    while (Date.now() < uploadVerifyDeadline) {
      const currentContainer = page.locator(
        inputReport.fieldComponentSelector,
      );

      if (await currentContainer.count()) {
        visibleText = await currentContainer.first().innerText();
      }

      if (
        visibleText.includes(path.basename(fixturePath))
        && /ready to upload/i.test(visibleText)
      ) {
        break;
      }

      await page.waitForTimeout(100);
    }

    const fileName = path.basename(fixturePath);
    const fileVisible = visibleText.includes(fileName);
    const readyToUpload = /ready to upload/i.test(visibleText);

    console.log('[UPLOAD DEBUG] Visible upload result:', {
      fileName,
      fileVisible,
      readyToUpload,
    });

    if (!fileVisible || !readyToUpload) {
      return uploadBlocker(
        field,
        'The upload component did not confirm the selected file as Ready to upload.',
        { completed, fileName, fileVisible, readyToUpload },
      );
    }

    const actualFile = {
      name: fileName,
      size: fixtureBytes.length,
    };



// Step 9: Confirm the filename appears in the visible UI.
console.log('[UPLOAD STEP] Checking visible filename');

const deadline = Date.now() + 5_000;
let filenameVisibleText = '';

while (Date.now() < deadline) {
  const currentContainer = page.locator(
    inputReport.fieldComponentSelector,
  );

  if (await currentContainer.count()) {
    filenameVisibleText = await currentContainer.first().innerText();
  }

  if (filenameVisibleText.includes(actualFile.name)) {
    break;
  }

  await page.waitForTimeout(100);
}

console.log('[UPLOAD STEP] Visible filename confirmed:', {
  fileName: actualFile.name,
  found: filenameVisibleText.includes(actualFile.name),
});

if (!filenameVisibleText.includes(actualFile.name)) {
  return uploadBlocker(
    field,
    `The input accepted ${actualFile.name}, but the filename was not confirmed in the visible Form.io field container.`,
    { completed, actualFile },
  );
}

    // Step 10: Check for visible validation errors.
    console.log('[UPLOAD STEP] Checking validation errors');

    const validationText = await container
      .locator(
        '[role="alert"], [aria-live="assertive"], .invalid-feedback',
      )
      .filter({ visible: true })
      .allTextContents();

    // const inputState = await input.evaluate(element => ({
    //   invalid: element.getAttribute('aria-invalid') === 'true',
    //   validationMessage: element.validationMessage || '',
    // }));

    
const inputStates = await input.evaluateAll(elements =>
  elements.map(element => ({
    invalid: element.getAttribute('aria-invalid') === 'true',
    validationMessage: element.validationMessage || '',
  })),
);

const inputState = inputStates[0] || {
  invalid: false,
  validationMessage: '',
};

console.log('[UPLOAD DEBUG] Input validation state:', inputState);


    const observedValidation = [
      ...validationText
        .map(text => text.replace(/\s+/g, ' ').trim())
        .filter(Boolean),
      inputState.validationMessage,
    ].filter(Boolean);

    if (inputState.invalid || observedValidation.length) {
      return uploadBlocker(
        field,
        observedValidation.join('; ')
          || 'The attached file is marked invalid by the field.',
        { completed, actualFile },
      );
    }

    completed.push({
      field: field.label,
      fieldKey: field.key,
      status: 'attached-and-visible',
      fileName: actualFile.name,
      sizeBytes: actualFile.size,
    });

    console.log('[UPLOAD STEP] Upload verified:', field.key);
  }

  console.log('[UPLOAD STEP] All required file inputs verified');

  return {
    status: 'attached',
    fields: completed,
    fixturePath: pngFixtures[0],
    fixtureUse:
      'approved synthetic UAT test fixture only; not represented as a genuine identity document',
  };
}



function redactText(value, sensitiveValues = []) {
  let redacted = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue && sensitiveValue.length >= 2) redacted = redacted.split(sensitiveValue).join('[REDACTED]');
  }
  return redacted
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\bBearer\s+[\w.-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[REDACTED_TOKEN]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[REDACTED_PHONE]');
}

function sanitizeResponseBody(value, sensitiveValues) {
  if (Array.isArray(value)) return value.map(item => sanitizeResponseBody(item, sensitiveValues));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeResponseBody(item, sensitiveValues),
    ]));
  }
  if (typeof value === 'string') return redactText(value, sensitiveValues).slice(0, 3000);
  return value;
}

function findSafetyBlockers(report, pageText) {
  const blockers = [];
  for (const field of report.fields) {
    const context = [field.label, field.choiceGroupLabel, field.surroundingLabel].filter(Boolean).join(' ');
    if (isFinancialDeclarationField(field)) continue;
    if (DECISION_BLOCKER.test(context)) {
      blockers.push({
        kind: 'meaningful-user-decision',
        field: field.label || field.id || field.name || `control-${field.index}`,
        observedContext: context,
        reason: 'This field appears to require a user decision or declaration; synthetic data will not be supplied.',
      });
    }
  }
  const uploadStageVisible = (report.tracker?.visibleText || [])
    .some(text => /\bupload documents?\b.*\b\d+\s*\/\s*\d+\b/i.test(text));
  const fileRequiredMessage = (pageText || '').split(/\r?\n/)
    .map(line => line.trim())
    .find(line => /^file is required\.?$/i.test(line));
  const fileFields = report.fields.filter(field => field.controlType === 'file');
  const uploadVerification = report.documentUploadVerification || null;
  if ((uploadStageVisible || fileRequiredMessage || fileFields.length)
    && (uploadVerification?.status !== 'attached' || fileRequiredMessage)) {
    const uploadInspection = report.documentUploadInspection || null;
    const failedField = uploadVerification?.failedField
      || (fileRequiredMessage ? 'Government ID front' : fileFields[0]?.label || 'Government ID front');
    blockers.push({
      kind: 'document-upload-requires-approved-test-fixture',
      fields: REQUIRED_EKYC_UPLOADS.map(field => ({
        field: field.label,
        fieldKey: field.key,
        observedField: fileFields.find(candidate => [candidate.name, candidate.id].includes(field.key))?.label || null,
        status: uploadVerification?.fields?.find(item => item.fieldKey === field.key)?.status
          || (uploadVerification?.fieldKey === field.key ? 'blocked' : 'not-attempted'),
      })),
      failedField,
      observedMessage: fileRequiredMessage || null,
      documentTypeOptions: uploadInspection?.options || [],
      committedDocumentTypes: uploadInspection?.committedDocumentTypes || [],
      documentInstructions: uploadInspection?.documentInstructions || null,
      fileInputs: uploadInspection?.fileInputs || [],
      fixture: uploadInspection?.fixture || null,
      uatSyntheticUploadPermission: uploadInspection?.uatSyntheticUploadPermission || 'not-established-from-project-or-rendered-UI',
      reason: uploadVerification?.reason
        || 'The upload controls were inspected, but attachment could not be verified. Continue was not clicked.',
    });
  }
  const visibleDecisionText = (pageText || '').split(/\r?\n/).map(line => line.trim()).filter(line => EXPLICIT_DECISION_TEXT.test(line));
  if (visibleDecisionText.length && !blockers.length) {
    blockers.push({
      kind: 'meaningful-user-decision',
      field: null,
      observedContext: [...new Set(visibleDecisionText)],
      reason: 'The visible page includes a declaration, consent, or sensitive financial/tax decision; the test will not answer it with synthetic data.',
    });
  }
  return blockers;
}

function syntheticValueFor(field) {
  const label = (field.label || '').toLowerCase();
  if (/\b(city|town)\b/.test(label)) return { value: 'QA Test City', category: 'synthetic-city' };
  if (/building|apartment|unit/.test(label)) return { value: '12A', category: 'synthetic-building-number' };
  if (/street/.test(label)) return { value: 'QA Test Street', category: 'synthetic-street' };
  if (/address/.test(label)) return { value: '12A QA Test Street', category: 'synthetic-address' };
  if (/po box|postal|postcode|zip/.test(label)) return { value: '12345', category: 'synthetic-postal-code' };
  if (/date of birth|birth date/.test(label)) return { value: '01/01/1990', category: 'synthetic-date' };
  return null;
}

function fieldMatchesValidationError(field, errorsFound) {
  const identifiers = [field.label, field.name, field.id]
    .filter(Boolean)
    .map(value => String(value).replace(/\s*\*\s*$/, '').trim().toLowerCase());
  return errorsFound.some(error => {
    const target = String(error.field || '').trim().toLowerCase();
    const message = String(error.message || '').trim().toLowerCase();
    return (target && identifiers.includes(target))
      || identifiers.some(identifier => identifier && message.startsWith(`${identifier} `));
  });
}

async function fillSafeSyntheticFields(page, form, testData, errorsFound = []) {
  const used = [];
  const unresolvedRequired = [];
  const preserved = [];
  const unresolvedChoiceGroups = new Set();
  const selectedChoiceGroups = new Set(form.fields
    .filter(field => (field.role === 'radio' || field.role === 'checkbox')
      && field.currentValue === true)
    .map(field => field.name || field.choiceGroupLabel || field.label || field.index));
  for (const field of form.fields) {
    const currentForm = await inspectDynamicForm(page);
    const liveField = currentForm.fields.find(candidate => fieldStateKey(candidate) === fieldStateKey(field));
    if (!liveField) {
      if (field.required || fieldMatchesValidationError(field, errorsFound)) {
        unresolvedRequired.push({
          field: field.label || field.id || field.name,
          reason: 'Field was no longer present in the latest rendered form; no stale locator was used.',
        });
      }
      continue;
    }
    const hasObservedValidationState = liveField.ariaInvalid || Boolean(liveField.validationMessage);
    const hasMatchedValidationError = fieldMatchesValidationError(liveField, errorsFound);
    if (!isEmptyFieldValue(liveField) && !hasObservedValidationState && !hasMatchedValidationError) {
      preserved.push({ field: liveField.label || liveField.id || liveField.name, status: 'preserved-existing-value' });
      continue;
    }
    if (!isEmptyFieldValue(liveField) && hasObservedValidationState && !hasMatchedValidationError) {
      unresolvedRequired.push({
        field: liveField.label || liveField.id || liveField.name,
        reason: 'The existing value is marked invalid, but no field-matched validation message and authorized correction rule were established.',
      });
      continue;
    }
    const choiceGroup = field.name || field.choiceGroupLabel || field.label || field.index;
    if ((field.role === 'radio' || field.role === 'checkbox') && selectedChoiceGroups.has(choiceGroup)) {
      preserved.push({ field: field.choiceGroupLabel || field.label, status: 'preserved-selected-choice' });
      continue;
    }
    const empty = isEmptyFieldValue(liveField);
    if (!empty && !fieldMatchesValidationError(field, errorsFound)) {
      preserved.push({ field: field.label || field.id || field.name, status: 'preserved-existing-value' });
      continue;
    }
    if (!liveField.required && !fieldMatchesValidationError(liveField, errorsFound)) continue;
    if (!liveField.enabled || liveField.readOnly) {
      if (liveField.required) unresolvedRequired.push({
        field: liveField.label || liveField.id || liveField.name,
        reason: 'Required field is empty but disabled or read-only.',
      });
      continue;
    }
    if (liveField.controlType === 'radio' || liveField.role === 'radio' || liveField.controlType === 'checkbox' || liveField.role === 'checkbox') {
      if (unresolvedChoiceGroups.has(choiceGroup)) continue;
      unresolvedChoiceGroups.add(choiceGroup);
      unresolvedRequired.push({
        field: liveField.choiceGroupLabel || liveField.label || liveField.id || liveField.name,
        reason: 'A required choice may represent a user-specific fact; the test will not select it.',
      });
      continue;
    }
    if (liveField.role === 'combobox' || liveField.controlType === 'select') {
      const discovery = form.dropdownOptionDiscovery?.find(item => item.field === (liveField.id || liveField.name || `${liveField.controlType}:${liveField.label || liveField.index}`));
      const isResidenceCountry = /^country$/i.test((liveField.label || '').replace(/\s*\*\s*$/, '').trim());
      const option = isResidenceCountry && testData.residenceCountry
        ? discovery?.options?.find(item => item.label?.toLowerCase() === testData.residenceCountry.toLowerCase() && item.disabled !== true)
        : null;
      if (!option) {
        unresolvedRequired.push({
          field: liveField.label || liveField.id || liveField.name,
          reason: isResidenceCountry
            ? 'No suitable visible option exactly matches the approved TEST_RESIDENCE_COUNTRY; an unrelated country will not be selected.'
            : `Visible options were inspected${discovery?.options?.length ? ` (${discovery.options.length} found)` : ''}, but no field-specific safe selection rule is available.`,
        });
        continue;
      }
      const locator = await locateField(page, liveField);
      if (!locator) {
        unresolvedRequired.push({ field: liveField.label || liveField.id || liveField.name, reason: 'The control could not be uniquely located.' });
        continue;
      }
      await locator.click();
      await page.getByRole('option', { name: option.label, exact: true }).click();
      const afterSelection = await inspectDynamicForm(page);
      const updatedField = afterSelection.fields.find(candidate => fieldStateKey(candidate) === fieldStateKey(liveField));
      if (!updatedField || !selectedOptionMatches(updatedField, option)
        || updatedField.ariaInvalid || updatedField.validationMessage) {
        unresolvedRequired.push({
          field: liveField.label || liveField.id || liveField.name,
          reason: `The selected option "${option.label}" was not confirmed as the committed value after re-inspecting the field.`,
        });
        continue;
      }
      used.push({ field: field.label, category: 'observed-dropdown-option', verifiedValue: option.label });
      continue;
    }

    const synthetic = syntheticValueFor(liveField);
    if (!synthetic) {
      unresolvedRequired.push({ field: liveField.label || liveField.id || liveField.name, reason: 'No field-specific synthetic-data rule is available.' });
      continue;
    }
    const locator = await locateField(page, liveField);
    if (!locator) {
      unresolvedRequired.push({ field: liveField.label || liveField.id || liveField.name, reason: 'The control could not be uniquely located by DOM identity or accessible name.' });
      continue;
    }
    if (liveField.controlType === 'date' && fieldMatchesValidationError(liveField, errorsFound)) {
      unresolvedRequired.push({
        field: liveField.label || liveField.id || liveField.name,
        reason: 'Date corrections must use the observed date-picker workflow, not direct text replacement.',
      });
      continue;
    }
    await locator.fill(synthetic.value);
    const afterFill = await inspectDynamicForm(page);
    const updated = afterFill.fields.find(candidate => fieldStateKey(candidate) === fieldStateKey(liveField));
    if (!updated || !valuesMatch(updated.currentValue, synthetic.value)
      || updated.ariaInvalid || updated.validationMessage) {
      unresolvedRequired.push({
        field: liveField.label || liveField.id || liveField.name,
        reason: updated?.ariaInvalid || updated?.validationMessage
          ? 'The entered synthetic value triggered a visible validation state and was not accepted.'
          : 'The entered value was not confirmed as committed when the control was inspected again.',
      });
      continue;
    }
    used.push({ field: liveField.label, category: synthetic.category });
  }
  return { used, preserved, unresolvedRequired };
}

function redactReport(report) {
  const redacted = JSON.parse(JSON.stringify(report));
  const redactFormValues = form => {
    if (!form) return;
    for (const field of form.fields || []) {
      if (field.currentValue !== null && field.currentValue !== '') field.currentValue = '[REDACTED]';
      if (field.displayedText !== null) field.displayedText = '[REDACTED]';
      if (field.constraints?.rawInputValue) field.constraints.rawInputValue = '[REDACTED]';
    }
    for (const discovery of form.dropdownOptionDiscovery || []) {
      if (discovery.originalValue !== null && discovery.originalValue !== '') discovery.originalValue = '[REDACTED]';
    }
    for (const verification of Object.values(form.prefilledFieldVerification || {})) {
      verification.fieldValue = '[REDACTED]';
    }
    if (form.nationalityDataComparison) {
      form.nationalityDataComparison.onboardingDisplayedValue = form.nationalityDataComparison.onboardingDisplayedValue
        ? '[REDACTED; non-empty value observed]'
        : null;
    }
  };
  for (const step of redacted.steps || []) {
    redactFormValues(step.form);
    for (const field of step.form?.fields || []) {
      if (field.labelResolution === 'unresolved') field.businessRuleClassification = 'Unknown/unresolved';
    }
    redactFormValues(step.submission?.resultingFormMetadata);
  }
  return redacted;
}

function recordObservedRequiredness(form, validationErrors) {
  const requirements = [];
  for (const error of validationErrors) {
    const match = String(error.message || '').match(/^(.+?)\s+is required\.?$/i);
    if (!match) continue;
    const requestedLabel = match[1].trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const matchedFields = form.fields.filter(field => {
      const labels = [field.label, field.choiceGroupLabel].filter(Boolean)
        .map(label => label.replace(/\s*\*\s*$/, '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
      const fieldName = String(field.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return labels.includes(requestedLabel)
        || ((field.role === 'radio' || field.controlType === 'radio') && fieldName.includes(requestedLabel));
    });
    for (const field of matchedFields) {
      field.required = true;
      field.requiredStatus = 'required-by-validation-response';
    }
    requirements.push({
      label: match[1].trim(),
      matchedFields: matchedFields.map(field => field.label || field.id || field.name),
      status: matchedFields.length ? 'matched-to-visible-controls' : 'visible-requirement-unresolved',
    });
  }
  form.observedValidationRequirements = requirements;
  return requirements;
}

function addDecisionTrace(report, event) {
  report.decisionTrace.push({
    sequence: report.decisionTrace.length + 1,
    observedAt: new Date().toISOString(),
    ...event,
  });
}

function fieldStateKey(field) {
  return field.id || field.name || `${field.controlType}:${field.label || field.index}`;
}

function buildFieldHandling(beforeFields, afterFields) {
  const afterByKey = new Map(afterFields.map(field => [fieldStateKey(field), field]));
  const selectedChoiceGroups = new Set(afterFields
    .filter(field => (field.role === 'radio' || field.role === 'checkbox') && field.currentValue === true)
    .map(field => field.name || field.choiceGroupLabel || field.label || field.index));
  return beforeFields.map(before => {
    const after = afterByKey.get(fieldStateKey(before));
    const choiceGroup = before.name || before.choiceGroupLabel || before.label || before.index;
    const beforeEmpty = isEmptyFieldValue(before);
    const afterEmpty = !after || isEmptyFieldValue(after);
    const sameValue = after && JSON.stringify(before.currentValue) === JSON.stringify(after.currentValue);
    let status;
    let reason;
    if ((before.role === 'radio' || before.role === 'checkbox')
      && after
      && selectedChoiceGroups.has(choiceGroup)
      && after.currentValue !== true) {
      status = 'unselected-option-in-satisfied-group';
      reason = 'Another option in this choice group is selected.';
    } else if (!beforeEmpty && sameValue) {
      status = 'preserved';
      reason = 'Existing control value was unchanged.';
    } else if (beforeEmpty && !afterEmpty) {
      status = 'populated';
      reason = 'An empty control received a value during the decision/fill cycle.';
    } else if (!beforeEmpty && !sameValue && after && (after.ariaInvalid || after.validationMessage)) {
      status = 'corrected-after-validation';
      reason = 'Value changed after the field exposed a validation error.';
    } else if (before.required && afterEmpty) {
      status = 'blocked';
      reason = 'Required field remains empty or uncommitted.';
    } else if (afterEmpty) {
      status = 'untouched-optional';
      reason = 'Optional field remained empty.';
    } else {
      status = 'changed-unverified';
      reason = 'Value changed without a matching observed field validation error.';
    }
    const context = [before.label, before.choiceGroupLabel, before.surroundingLabel, before.id, before.name]
      .filter(Boolean).join(' ');
    const valueForReport = value => {
      if (value === null || value === undefined || value === '') return value ?? null;
      if (before.controlType === 'file' || SENSITIVE_KEY.test(context)) return '[REDACTED]';
      return value;
    };
    return {
      field: before.label || before.choiceGroupLabel || before.id || before.name || `control-${before.index}`,
      controlType: before.controlType,
      required: before.required,
      originalValue: valueForReport(before.currentValue),
      finalValue: valueForReport(after?.currentValue ?? null),
      status,
      reason,
    };
  });
}

function pagePosition(form, fallbackStep) {
  const current = Number(form.tracker?.currentStep);
  const total = Number(form.tracker?.totalSteps);
  return {
    current: Number.isFinite(current) && current > 0 ? current : fallbackStep,
    total: Number.isFinite(total) && total > 0 ? total : '?',
  };
}

function logPageHeader(form, fallbackStep) {
  const position = pagePosition(form, fallbackStep);
  const title = redactText(form.stepTitle || form.pageTitle || 'Untitled onboarding page');
  console.log(`\n[PAGE ${position.current}/${position.total}] ${title}`);
  return position;
}

function logFieldStatus(status, label, detail = '') {
  const conciseDetail = detail ? ` — ${redactText(String(detail)).replace(/\s+/g, ' ').trim()}` : '';
  console.log(`  [${status}] ${redactText(label || 'Unlabeled field')}${conciseDetail}`);
}

function logFieldHandling(fieldHandling, validationErrors = [], fieldIssues = []) {
  const loggedFields = new Set();
  for (const field of fieldHandling) {
    if (field.status === 'untouched-optional' || field.status === 'unselected-option-in-satisfied-group') continue;
    if (loggedFields.has(field.field)) continue;
    loggedFields.add(field.field);
    const matchingError = validationErrors.find(error => error.field
      && String(error.field).toLowerCase() === String(field.field).toLowerCase());
    const matchingIssue = fieldIssues.find(issue => issue.field
      && String(issue.field).toLowerCase() === String(field.field).toLowerCase());
    if (matchingError) {
      logFieldStatus('FAIL', field.field, matchingError.message);
    } else if (matchingIssue) {
      logFieldStatus('BLOCKED', field.field, matchingIssue.reason);
    } else if (field.status === 'blocked') {
      logFieldStatus('BLOCKED', field.field, field.reason);
    } else if (['populated', 'preserved', 'corrected-after-validation', 'unselected-option-in-satisfied-group'].includes(field.status)) {
      logFieldStatus('PASS', field.field);
    } else {
      logFieldStatus('BLOCKED', field.field, field.reason);
    }
  }
}

function logUploadVerification(verification) {
  if (verification.status === 'attached') {
    for (const field of verification.fields) logFieldStatus('PASS', field.field);
    logFieldStatus('PASS', 'Files attached');
    return;
  }
  const completedKeys = new Set((verification.completed || []).map(field => field.fieldKey));
  for (const field of REQUIRED_EKYC_UPLOADS) {
    if (completedKeys.has(field.key)) {
      logFieldStatus('PASS', field.label);
    } else if (verification.fieldKey === field.key) {
      logFieldStatus('BLOCKED', field.label, verification.reason);
    } else {
      logFieldStatus('BLOCKED', field.label, `Not attempted because ${verification.failedField} could not be verified.`);
    }
  }
  logFieldStatus('BLOCKED', 'Files attached', 'One or more required uploads are missing or unverified.');
}

function onboardingCompletionEvidence(text, tracker) {
  const visibleText = String(text || '');
  const percentComplete = /\b100\s*%\s*(?:complete|completed)\b/i.test(visibleText)
    || /\b(?:complete|completed)\s*(?:at\s*)?100\s*%\b/i.test(visibleText);
  const completionMessage = /\b(?:onboarding|profile|application).{0,50}\b(?:complete|completed|successful|successfully)\b|\b(?:complete|completed|successful|successfully).{0,50}\b(?:onboarding|profile|application)\b/i.test(visibleText);
  const trackerComplete = Number.isFinite(Number(tracker?.currentStep))
    && Number.isFinite(Number(tracker?.totalSteps))
    && Number(tracker.currentStep) === Number(tracker.totalSteps);
  const visibleCompletionConfirmation = completionMessage
    || /\bcongratulations\b/i.test(visibleText);
  if (percentComplete && visibleCompletionConfirmation) {
    return {
      verified: true,
      evidence: 'Visible 100% completion text and a completion confirmation were both observed.',
      excerpt: visibleText.match(/.{0,60}100\s*%.*(?:complete|completed).{0,60}/i)?.[0] || null,
    };
  }
  if (trackerComplete && visibleCompletionConfirmation) {
    return {
      verified: true,
      evidence: 'The visible onboarding tracker reached its total and a completion confirmation was observed.',
      excerpt: visibleText.match(/.{0,60}(?:complete|completed|success|congratulations).{0,60}/i)?.[0] || null,
    };
  }
  return { verified: false, evidence: null, excerpt: null };
}

function stepVisitKey(form) {
  return [
    new URL(form.url).pathname,
    form.stepTitle || '',
    form.tracker?.currentStep || '',
    form.tracker?.totalSteps || '',
    form.fields.map(fieldStateKey).join(','),
  ].join('|');
}

function formStateSignature(form) {
  return JSON.stringify({
    url: form.url,
    title: form.stepTitle,
    tracker: form.tracker,
    fields: form.fields.map(field => ({
      key: fieldStateKey(field),
      value: field.currentValue,
      invalid: field.ariaInvalid,
      validationMessage: field.validationMessage,
    })),
    messages: form.validationMessages,
  });
}

async function waitForPostSubmitUi(page, beforeForm, timeoutMs = 8_000) {
  const beforeSignature = formStateSignature(beforeForm);
  const startedAt = Date.now();
  let current = await inspectDynamicForm(page);
  while (Date.now() - startedAt < timeoutMs
    && formStateSignature(current) === beforeSignature) {
    await page.waitForTimeout(400);
    current = await inspectDynamicForm(page);
  }
  const changed = formStateSignature(current) !== beforeSignature;
  if (changed) {
    await page.waitForTimeout(250);
    current = await inspectDynamicForm(page);
  }
  return { form: current, changed, waitedMs: Date.now() - startedAt };
}

async function inspectVisibleFrames(page) {
  const observations = [];
  for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    try {
      const body = frame.locator('body');
      const observation = await body.evaluate(element => {
        const visible = candidate => {
          const style = window.getComputedStyle(candidate);
          const rect = candidate.getBoundingClientRect();
          return candidate.getClientRects().length > 0
            && rect.width > 0
            && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        };
        const buttons = Array.from(element.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
          .filter(visible)
          .map(button => (button.innerText || button.value || button.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        return {
          text: (element.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000),
          buttons,
        };
      });
      if (frame.parentFrame()) {
        const frameElement = await frame.frameElement();
        const visibleFrame = await frameElement.evaluate(element => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return element.getClientRects().length > 0
            && rect.width > 0
            && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        });
        if (!visibleFrame) continue;
      }
      observations.push({
        isMainFrame: frame === page.mainFrame(),
        text: observation.text,
        buttons: observation.buttons,
      });
    } catch (error) {
      if (frame.isDetached() || /execution context was destroyed|frame was detached|cannot find context/i.test(error.message)) {
        continue;
      }
      throw error;
    }
  }
  return observations;
}

async function waitForOnboardingStepSurface(page, timeoutMs = ONBOARDING_FORM_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let manualEkycDetected = false;
  let sumsubEvidence = null;

  while (Date.now() < deadline) {
    const observations = await inspectVisibleFrames(page);
    const visibleText = observations.map(frame => frame.text).join('\n');
    const visibleButtons = observations.flatMap(frame => frame.buttons);
    const trackerShowsPageThree = /\b(?:page|step)\s*3\s*(?:of|\/)\s*6\b|\b3\s*\/\s*6\b/i.test(visibleText);
    const sumsubBrandingVisible = /\bsumsub\b/i.test(visibleText);
    const verificationIntroductionVisible = /\b(?:verify your identity|identity verification|start (?:your )?verification|verification process|complete (?:your )?verification)\b/i.test(visibleText);
    const continueVisible = visibleButtons.some(label => /^continue$/i.test(label));
    const detected = sumsubBrandingVisible
      || verificationIntroductionVisible
      || (trackerShowsPageThree && continueVisible);

    if (detected && !manualEkycDetected) {
      manualEkycDetected = true;
      sumsubEvidence = {
        sumsubBrandingVisible,
        verificationIntroductionVisible,
        trackerShowsPageThree,
        continueVisible,
      };
      console.log('[E-KYC] Sumsub detected. Waiting for manual user verification (maximum 120 seconds).');
    }

    const form = await inspectDynamicForm(page);
    const completion = onboardingCompletionEvidence(observations
      .filter(frame => frame.isMainFrame)
      .map(frame => frame.text)
      .join('\n'), form.tracker);
    if (manualEkycDetected) {
      const trackerStep = Number(form.tracker.currentStep);
      const laterOnboardingFormVisible = form.fields.length > 0
        && Number.isFinite(trackerStep)
        && trackerStep > 3;
      if (laterOnboardingFormVisible || completion.verified) {
        return {
          ready: true,
          timedOut: false,
          manualEkyc: {
            detected: true,
            completed: true,
            evidence: sumsubEvidence,
            nextForm: laterOnboardingFormVisible
              ? { title: form.stepTitle, url: form.url, tracker: form.tracker, fields: form.fields }
              : null,
            completion: completion.verified ? completion : null,
          },
        };
      }
    } else {
      const visibleControl = await page.evaluate(selectors => Array.from(document.querySelectorAll(selectors)).some(element => {
        const style = window.getComputedStyle(element);
        return element.getClientRects().length > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden';
      }) || Boolean(document.querySelector('input[type="file"]')), FORM_CONTROLS);
      if (visibleControl || completion.verified) return { ready: true, timedOut: false };
    }

    await page.waitForTimeout(Math.min(500, Math.max(0, deadline - Date.now())));
  }

  return {
    ready: false,
    timedOut: true,
    manualEkyc: manualEkycDetected
      ? {
        detected: true,
        completed: false,
        timedOut: true,
        evidence: sumsubEvidence,
        reason: 'E-KYC manual verification was not completed within 120 seconds.',
      }
      : null,
  };
}

function createDiscoveryReport() {
  return {
    generatedAt: new Date().toISOString(),
    accountType: 'Individual',
    authenticated: false,
    steps: [],
    visitedSteps: [],
    transitions: [],
    initialTracker: null,
    finalTracker: null,
    syntheticDataCategoriesUsed: [],
    validationErrorsAndCorrections: [],
    submissionOutcomes: [],
    decisionTrace: [],
    finalCompletionVerified: false,
    blocker: null,
    factsVsInferences: [],
  };
}

async function persistReport(report, testInfo, attachmentName = 'individual-onboarding-discovery.json') {
  const privacySafeReport = redactReport(report);
  const serialized = JSON.stringify(privacySafeReport, null, 2);
  const reportPath = path.join(process.cwd(), 'test-results', 'individual-onboarding-discovery.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, serialized, 'utf8');
  await testInfo.attach(attachmentName, {
    body: serialized,
    contentType: 'application/json',
  });
  return serialized;
}

function writeProgressReport(report) {
  const privacySafeReport = redactReport(report);
  const reportPath = path.join(process.cwd(), 'test-results', 'individual-onboarding-discovery.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(privacySafeReport, null, 2), 'utf8');
}

async function saveLatestRunAttempt(report, testInfo) {
  await persistReport(report, testInfo);
}

async function inspectDateUi(page, input) {
  return input.evaluate(element => {
    const visible = candidate => {
      const style = window.getComputedStyle(candidate);
      return candidate.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const attributes = candidate => ({
      tag: candidate.tagName.toLowerCase(),
      type: candidate.getAttribute('type'),
      role: candidate.getAttribute('role'),
      label: candidate.getAttribute('aria-label') || candidate.getAttribute('name') || null,
      placeholder: candidate.getAttribute('placeholder'),
      value: 'value' in candidate ? candidate.value : null,
      text: (candidate.innerText || candidate.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100) || null,
      className: typeof candidate.className === 'string' ? candidate.className.slice(0, 120) : null,
      disabled: candidate.disabled === true || candidate.getAttribute('aria-disabled') === 'true',
      selected: candidate.getAttribute('aria-selected') === 'true' || candidate.getAttribute('aria-pressed') === 'true',
      invalid: candidate.getAttribute('aria-invalid') === 'true',
    });
    const calendar = Array.from(document.querySelectorAll('[role="dialog"], [role="grid"], [class*="calendar" i], [class*="datepicker" i], [class*="date-picker" i]'))
      .find(candidate => visible(candidate) && candidate !== element);
    const calendarControls = calendar
      ? Array.from(calendar.querySelectorAll('input, select, button, [role="combobox"], [role="gridcell"], [role="button"]')).filter(visible).map(attributes)
      : Array.from(document.querySelectorAll('input, select, button, [role="combobox"], [role="gridcell"], [role="button"]'))
        .filter(visible)
        .map(attributes)
        .filter(control => /month|year|calendar|date/i.test(`${control.label || ''} ${control.placeholder || ''} ${control.className || ''}`));
    return {
      input: attributes(element),
      inputType: element.getAttribute('type') || 'text',
      formatHint: element.getAttribute('placeholder') || null,
      calendarVisible: Boolean(calendar),
      calendarRole: calendar?.getAttribute('role') || null,
      calendarClass: calendar && typeof calendar.className === 'string' ? calendar.className.slice(0, 120) : null,
      calendarId: calendar?.id || null,
      calendarText: calendar ? (calendar.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300) : null,
      calendarControls,
      validationText: (element.getAttribute('aria-describedby') || '').split(/\s+/)
        .map(id => document.getElementById(id)?.innerText || '')
        .filter(Boolean)
        .join(' ').replace(/\s+/g, ' ').trim(),
    };
  });
}

function normalizedDate(value) {
  const match = String(value || '').match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  return match ? `${match[1].padStart(2, '0')}/${match[2].padStart(2, '0')}/${match[3]}` : null;
}

async function chooseSyntheticDate(page, form) {
  const field = form.fields.find(candidate => /^date of birth$/i.test((candidate.label || '').replace(/\s*\*\s*$/, '').trim()));
  const event = {
    decision: 'date-of-birth',
    required: Boolean(field?.required),
    evidence: { fieldFound: Boolean(field), placeholder: field?.placeholder || null, initialValuePresent: Boolean(field?.currentValue) },
    action: null,
    reason: 'Use a fixed synthetic QA date and commit it through the observed date UI; never use Signup data as DOB.',
    result: null,
    retries: 0,
    unresolved: [],
  };
  if (!field) {
    event.unresolved.push('Date of Birth control was not found.');
    return event;
  }

  const input = await locateField(page, field);
  if (!input) {
    event.unresolved.push('Date of Birth control was not uniquely locatable.');
    return event;
  }

  const before = await inspectDateUi(page, input);
  const existingDate = normalizedDate(before.input.value);
  if (existingDate && !before.input.invalid && !before.validationText) {
    event.evidence.before = before;
    event.action = 'Preserved the existing valid Date of Birth without opening or changing the date picker.';
    event.result = {
      observedValue: before.input.value,
      normalizedObservedValue: existingDate,
      registered: true,
      preserved: true,
      ariaInvalid: false,
      validationMessage: before.validationText || null,
    };
    return event;
  }
  if (before.input.value && !before.input.invalid && !before.validationText) {
    event.evidence.before = before;
    event.unresolved.push('Date of Birth contains a non-empty value whose format could not be verified; it was preserved.');
    return event;
  }
  await input.click();
  await page.waitForTimeout(200);
  const opened = await inspectDateUi(page, input);
  event.evidence = {
    ...event.evidence,
    before,
    afterOpen: opened,
  };

  const monthSelects = page.locator('select:visible');
  let chosenThroughCalendar = false;
  if (opened.calendarVisible) {
    const selectors = [];
    for (let index = 0; index < await monthSelects.count(); index += 1) {
      const select = monthSelects.nth(index);
      const optionLabels = await select.locator('option').allTextContents();
      const january = optionLabels.find(label => /^(january|jan)$/i.test(label.trim()));
      if (january) {
        selectors.push({ select, monthLabel: january });
        break;
      }
    }
    const yearCandidates = page.locator('input:visible').filter({ visible: true });
    let yearInput = null;
    for (let index = 0; index < await yearCandidates.count(); index += 1) {
      const candidate = yearCandidates.nth(index);
      const attrs = await candidate.evaluate(element => [
        element.getAttribute('aria-label'),
        element.getAttribute('name'),
        element.getAttribute('placeholder'),
        element.getAttribute('class'),
      ].filter(Boolean).join(' '));
      if (/year/i.test(attrs)) {
        yearInput = candidate;
        break;
      }
    }

    if (selectors.length && yearInput) {
      await selectors[0].select.selectOption({ label: selectors[0].monthLabel });
      const afterMonth = await inspectDateUi(page, input);
      await yearInput.click();
      await yearInput.press('Control+A');
      await yearInput.pressSequentially('1990');
      await yearInput.press('Tab');
      await page.waitForTimeout(150);
      const afterYear = await inspectDateUi(page, input);
      event.evidence.monthSelection = { observedOption: selectors[0].monthLabel, after: afterMonth };
      event.evidence.yearEntry = { value: '1990', after: afterYear };
      const calendarSelector = afterYear.calendarId
        ? `#${afterYear.calendarId}`
        : afterYear.calendarClass
          ? `[class~=${JSON.stringify(afterYear.calendarClass.trim().split(/\s+/)[0])}]`
          : '[role="grid"]:visible, [role="dialog"]:visible, [class*="calendar"]:visible, [class*="datepicker"]:visible';
      const calendarRoot = page.locator(calendarSelector).filter({ visible: true }).first();
      const dayControls = calendarRoot.locator('.flatpickr-day, [role="gridcell"], td button, button');
      const exactDay = [];
      for (let index = 0; index < await dayControls.count(); index += 1) {
        const candidate = dayControls.nth(index);
        const details = await candidate.evaluate(element => ({
          text: (element.innerText || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
          label: element.getAttribute('aria-label') || element.getAttribute('title') || '',
          className: typeof element.className === 'string' ? element.className : '',
          disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
        }));
        const inTargetMonth = !/prevMonthDay|nextMonthDay|disabled|notAllowed/i.test(details.className);
        if (!details.disabled && inTargetMonth && /january 1,? 1990/i.test(details.label)) {
          exactDay.push({ candidate, details });
        }
      }
      if (exactDay.length === 1) {
        await exactDay[0].candidate.click();
        chosenThroughCalendar = true;
        event.evidence.daySelection = exactDay[0].details;
      } else {
        event.unresolved.push(`Calendar day 1 was not uniquely exposed as a selectable control (${exactDay.length} matches).`);
      }
    } else {
      event.unresolved.push('Calendar opened, but a visible January selector and Year input were not both exposed; no calendar date was selected.');
    }
  }

  if (!opened.calendarVisible) {
    const enteredValue = '01/01/1990';
    await input.fill(enteredValue);
    await input.press('Enter');
    await input.press('Tab');
    event.action = 'Typed synthetic date using the visible DD/MM/YYYY format, then committed with Enter and blur.';
  } else if (chosenThroughCalendar) {
    event.action = 'Selected January and year 1990 in the visible calendar, then selected day 1.';
  }

  const after = await inspectDynamicForm(page);
  const updatedField = after.fields.find(candidate => /^date of birth$/i.test((candidate.label || '').replace(/\s*\*\s*$/, '').trim()));
  const expectedDate = '01/01/1990';
  const actualDate = normalizedDate(updatedField?.currentValue);
  const registered = actualDate === expectedDate
    && !updatedField?.ariaInvalid
    && !updatedField?.validationMessage;
  event.result = {
    expectedSyntheticValue: expectedDate,
    observedValue: updatedField?.currentValue ?? null,
    normalizedObservedValue: actualDate,
    ariaInvalid: updatedField?.ariaInvalid ?? null,
    validationMessage: updatedField?.validationMessage || null,
    registered,
    afterUi: updatedField ? await inspectDateUi(page, input) : null,
  };
  if (!registered) event.unresolved.push('The application did not visibly register the synthetic date as valid.');
  return event;
}

async function chooseApprovedGender(page, form) {
  const approvedValue = String(process.env.TEST_GENDER || '').trim().toLowerCase();
  const options = form.fields
    .filter(field => field.role === 'radio' && /^gender$/i.test(field.choiceGroupLabel || ''))
    .map(field => ({ label: field.label, value: field.options.find(option => option.label === field.label)?.value ?? null, selected: field.currentValue === true }));
  const selectedOption = options.find(option => option.selected);
  const event = {
    decision: 'gender',
    required: form.fields.some(field => field.role === 'radio' && /^gender$/i.test(field.choiceGroupLabel || '') && field.required),
    evidence: {
      approvedValueConfigured: Boolean(approvedValue),
      approvedValue: approvedValue || null,
      availableRadioOptions: options,
      existingSelection: selectedOption || null,
    },
    action: null,
    reason: selectedOption
      ? 'Preserve an existing radio selection; TEST_GENDER applies only when Gender is empty.'
      : approvedValue
        ? 'Use TEST_GENDER only if it exactly matches an observed radio value.'
        : 'No approved TEST_GENDER value is configured; do not infer or guess a personal attribute.',
    result: null,
    retries: 0,
    unresolved: [],
  };
  if (selectedOption) {
    event.action = 'Preserved the existing selected Gender radio option.';
    event.result = {
      observedSelectedLabel: selectedOption.label,
      observedValue: selectedOption.value,
      selected: true,
      preserved: true,
    };
    return event;
  }
  if (!approvedValue) {
    event.unresolved.push('TEST_GENDER is not set; required Gender cannot be answered safely.');
    return event;
  }
  const option = options.find(candidate => candidate.value === approvedValue);
  if (!option) {
    event.unresolved.push('Configured TEST_GENDER does not match an actual observed radio value.');
    return event;
  }
  const radioField = form.fields.find(field => field.role === 'radio'
    && /^gender$/i.test(field.choiceGroupLabel || '')
    && field.options.some(candidate => candidate.value === approvedValue));
  const radio = radioField ? await locateField(page, radioField) : null;
  if (!radio) {
    event.unresolved.push('The selected Gender radio option could not be uniquely located.');
    return event;
  }
  await radio.check();
  const after = await inspectDynamicForm(page);
  const updated = after.fields.find(field => field.role === 'radio'
    && /^gender$/i.test(field.choiceGroupLabel || '')
    && field.options.some(candidate => candidate.value === approvedValue));
  const selected = updated?.currentValue === true;
  event.action = `Selected observed radio value ${approvedValue}.`;
  event.result = {
    observedSelectedLabel: updated?.label || null,
    observedValue: approvedValue,
    selected,
    preserved: false,
    ariaInvalid: updated?.ariaInvalid ?? null,
  };
  if (!selected) event.unresolved.push('The application did not expose the approved Gender option as selected after interaction.');
  return event;
}

async function chooseTestResidenceCountry(page, form, countryName) {
  const field = form.fields.find(candidate => /^country$/i.test((candidate.label || '').replace(/\s*\*\s*$/, '').trim()));
  const event = {
    decision: 'residence-country',
    required: Boolean(field?.required),
    evidence: {
      approvedResidenceCountryConfigured: Boolean(countryName),
      approvedResidenceCountry: countryName || null,
      source: countryName ? 'TEST_RESIDENCE_COUNTRY from the local test environment.' : null,
      fieldFound: Boolean(field),
    },
    action: null,
    reason: 'Preserve committed prefill; otherwise exhaust actual options, prefer the approved residence country, then use only the explicitly authorized first meaningful UI option fallback.',
    result: null,
    retries: 0,
    unresolved: [],
  };
  if (!field) {
    event.unresolved.push('A Country field could not be identified from the current form metadata.');
    return event;
  }
  const combo = await locateField(page, field);
  if (!combo) {
    event.unresolved.push('The observed Country control could not be uniquely located in the rendered DOM.');
    return event;
  }
  event.evidence.initialControlState = await inspectCountrySelection(combo);
  const result = await selectApprovedCountry(page, combo, countryName, {
    allowFirstMeaningfulFallback: true,
  });
  event.result = result;
  event.action = result.status === 'prefilled-preserved'
    ? 'Preserved the already committed Country value without opening or changing the control.'
    : result.status === 'selected-and-verified'
      ? `Selected "${result.selectedOption.label}" (option value: ${result.selectedOption.value || 'not exposed'}) and verified it was committed${result.selectedBy === 'first-enabled-meaningful-ui-option-qa-fallback' ? ' using the authorized QA fallback' : ''}.`
      : 'Inspected Country without selecting or submitting an unverified value.';
  if (!['prefilled-preserved', 'selected-and-verified'].includes(result.status)) {
    event.unresolved.push(result.reason);
  }
  return event;
}

async function runOnboardingAutomation(page, testInfo) {
    const report = createDiscoveryReport();
    report.authentication = {
      status: 'Signup and Sign In were completed by the enclosing end-to-end test.',
    };
    const currentUrl = new URL(page.url());
    const profileButton = page.getByRole('button', { name: 'Profile', exact: true });
    const authenticated = /\/onboarding(?:\/|$)/i.test(currentUrl.pathname) && await profileButton.isVisible();

    if (!authenticated) {
      report.blocker = {
        kind: 'authenticated-onboarding-not-visible',
        reason: `Sign In did not leave the test on authenticated onboarding (current path: ${currentUrl.pathname}).`,
      };
      await persistReport(report, testInfo);
      throw new Error(report.blocker.reason);
    }

    report.authenticated = true;
    expect(currentUrl.pathname, 'Onboarding route should be accessible with the existing authenticated context').toMatch(/\/onboarding(?:\/|$)/i);
    let formWaitTimedOut = false;
    const waitStartedAt = Date.now();
    try {
      await page.waitForFunction(
        selector => Array.from(document.querySelectorAll(selector)).some(element => {
          const style = window.getComputedStyle(element);
          return element.getClientRects().length > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden';
        }),
        FORM_CONTROLS,
        { timeout: ONBOARDING_FORM_WAIT_MS },
      );
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
      formWaitTimedOut = true;
    }
    report.authentication.onboardingUiWaitMs = Date.now() - waitStartedAt;
    const currentOnboardingUrl = new URL(page.url());
    if (!/\/onboarding(?:\/|$)/i.test(currentOnboardingUrl.pathname)
      || !await profileButton.isVisible()) {
      const blocker = {
        kind: 'authenticated-session-expired',
        reason: `The authenticated session no longer exposes onboarding after waiting for its UI (current path: ${currentOnboardingUrl.pathname}).`,
      };
      report.blocker = blocker;
      await persistReport(report, testInfo);
      throw new Error(blocker.reason);
    }

    const formProbe = await inspectDynamicForm(page);
    if (!formProbe.fields.length) {
      const diagnosticText = await page.locator('body').innerText();
      report.blocker = {
        kind: formWaitTimedOut ? 'onboarding-form-load-timeout' : 'onboarding-form-not-visible',
        reason: formWaitTimedOut
          ? `The authenticated onboarding route remained on ${currentUrl.pathname} but displayed no form controls within ${ONBOARDING_FORM_WAIT_MS / 1000} seconds.`
          : 'The authenticated onboarding route did not expose any visible form controls after its initial UI wait.',
        observedUi: {
          url: formProbe.url,
          pageTitle: formProbe.pageTitle,
          visibleHeadings: formProbe.visibleHeadings,
          tracker: formProbe.tracker,
          visibleTextExcerpt: redactText(diagnosticText).slice(0, 1000),
        },
      };
      addDecisionTrace(report, {
        decision: 'verify-onboarding-access',
        evidence: { url: formProbe.url, title: formProbe.stepTitle },
        action: `Waited up to ${ONBOARDING_FORM_WAIT_MS / 1000} seconds for visible onboarding controls; no form interaction performed.`,
        reason: 'Authenticated route alone is not proof that the onboarding form rendered.',
        result: 'Onboarding form was not reached.',
        retries: 0,
        unresolved: [report.blocker.reason],
      });
      await saveLatestRunAttempt(report, testInfo);
      throw new Error(report.blocker.reason);
    }

    const MAX_STEP_VISITS = 30;
    const visitedStepKeys = new Set();
    for (let stepIndex = 0; stepIndex < MAX_STEP_VISITS; stepIndex += 1) {
      const stepSurface = await waitForOnboardingStepSurface(page);
      const form = await inspectDynamicForm(page);
      if (stepSurface.manualEkyc?.detected) {
        addDecisionTrace(report, {
          decision: 'manual-sumsub-ekyc-checkpoint',
          evidence: stepSurface.manualEkyc.evidence,
          action: 'Kept the browser available for manual Sumsub verification; no Continue or verification controls were clicked.',
          result: stepSurface.manualEkyc.completed
            ? 'A later onboarding form or explicit application completion state was observed.'
            : 'Manual verification did not finish within the 120-second wait.',
          retries: 0,
          unresolved: stepSurface.manualEkyc.completed
            ? []
            : [stepSurface.manualEkyc.reason],
        });
        if (stepSurface.manualEkyc.completed && stepSurface.manualEkyc.nextForm) {
          report.transitions.push({
            step: Number(form.tracker.currentStep) - 1,
            from: {
              title: 'Sumsub e-KYC manual verification',
              tracker: { currentStep: 3, totalSteps: form.tracker.totalSteps },
            },
            to: {
              title: form.stepTitle,
              url: form.url,
              tracker: form.tracker,
            },
            progressConfirmed: true,
            outcome: 'manual-ekyc-completed-and-next-form-observed',
          });
        }
      }
      if (!form.fields.length) {
        const visibleText = await page.locator('body').innerText();
        const completion = onboardingCompletionEvidence(visibleText, form.tracker);
        if (completion.verified) {
          report.finalCompletionVerified = true;
          report.finalTracker = form.tracker;
          report.completionEvidence = {
            observedText: completion.excerpt,
            verification: completion.evidence,
            url: form.url,
            tracker: form.tracker,
          };
          break;
        }
        if (stepSurface.manualEkyc?.timedOut) {
          report.blocker = {
            step: 3,
            title: 'Sumsub e-KYC manual verification',
            kind: 'manual-ekyc-timeout',
            tracker: form.tracker,
            reason: 'E-KYC manual verification was not completed within 120 seconds.',
            details: [{
              evidence: stepSurface.manualEkyc.evidence,
              result: 'The next onboarding form or an explicit application completion state was not detected.',
            }],
            status: 'Stopped safely without interacting with the Sumsub verification UI.',
          };
          logFieldStatus('BLOCKED', 'Sumsub manual verification', report.blocker.reason);
          break;
        }
        report.blocker = {
          step: stepIndex + 1,
          kind: stepSurface.timedOut ? 'next-step-ui-timeout' : 'onboarding-form-not-visible',
          details: [{
            url: form.url,
            title: form.stepTitle,
            tracker: form.tracker,
            reason: stepSurface.timedOut
              ? `No visible form control or completion evidence appeared within ${ONBOARDING_FORM_WAIT_MS / 1000} seconds.`
              : 'The onboarding page exposed neither visible form controls nor verified completion evidence.',
          }],
        };
        break;
      }
      if (stepSurface.manualEkyc?.completed) {
        const nextPosition = pagePosition(form, stepIndex + 1);
        console.log(`[E-KYC] Manual verification completed. Resuming Dynamic Form Inspector on Page ${nextPosition.current}/${nextPosition.total}.`);
      }
      expect(form.url, 'Every inspected page must remain on an authenticated onboarding route').toMatch(/\/onboarding(?:\/|$|\?)/i);
      expect(form.fields.length, 'A step title without a visible form is not accepted as an onboarding form').toBeGreaterThan(0);
      if (!report.initialTracker) report.initialTracker = form.tracker;
      report.finalTracker = form.tracker;
      const visitKey = stepVisitKey(form);
      if (visitedStepKeys.has(visitKey)) {
        report.blocker = {
          step: stepIndex + 1,
          title: form.stepTitle,
          kind: 'repeated-step-detected',
          details: [{
            url: form.url,
            tracker: form.tracker,
            reason: 'The same URL, title, tracker position, and control identities were visited more than once.',
          }],
        };
        break;
      }
      visitedStepKeys.add(visitKey);
      const initialFields = form.fields.map(field => ({ ...field }));
      report.visitedSteps.push({
        sequence: report.visitedSteps.length + 1,
        url: form.url,
        title: form.stepTitle,
        tracker: form.tracker,
        fieldCount: form.fields.length,
      });
      logPageHeader(form, report.visitedSteps.length);

      form.prefilledFieldVerification = Object.fromEntries(['First Name', 'Last Name', 'Mobile Number'].map(label => [label, {
        status: 'not verified in this run',
        reason: 'The sign-up flow did not expose account values for comparison with these rendered onboarding fields.',
      }]));
      const nationalityField = form.fields.find(field => /^nationality(?:\s+\d+)?$/i.test(field.label || ''));
      form.nationalityDataComparison = {
        fieldLabel: nationalityField?.label || null,
        accountValueAvailable: false,
        onboardingDisplayedValue: nationalityField?.displayedText || nationalityField?.currentValue || null,
        mappingVerified: false,
        residenceCountryTreatedAsNationality: false,
        status: nationalityField ? 'observed; account mapping cannot be verified from the rendered onboarding form' : 'not present on this step',
      };
      const stepDecisions = [];
      if (form.fields.some(field => /^country$/i.test((field.label || '').replace(/\s*\*\s*$/, '').trim()))) {
        const countryDecision = await chooseTestResidenceCountry(page, await inspectDynamicForm(page), TEST_RESIDENCE_COUNTRY);
        stepDecisions.push(countryDecision);
        addDecisionTrace(report, countryDecision);
      }
      if (form.fields.some(field => /^date of birth$/i.test((field.label || '').replace(/\s*\*\s*$/, '').trim()))) {
        const dateDecision = await chooseSyntheticDate(page, form);
        stepDecisions.push(dateDecision);
        addDecisionTrace(report, dateDecision);
      }
      if (form.fields.some(field => field.role === 'radio' && /^gender$/i.test(field.choiceGroupLabel || ''))) {
        const genderDecision = await chooseApprovedGender(page, await inspectDynamicForm(page));
        stepDecisions.push(genderDecision);
        addDecisionTrace(report, genderDecision);
      }
      form.dropdownOptionDiscovery = await discoverDropdownOptions(page, await inspectDynamicForm(page));
      form.conditionalBehavior = await investigateConditionalFields(page, form);
      if (/upload documents?/i.test(form.stepTitle || '')
        || form.fields.some(field => field.controlType === 'file')) {
        form.documentUploadInspection = await inspectEkycUpload(page);
        form.documentUploadVerification = await attachApprovedEkycFixture(
          page,
          form.documentUploadInspection,
        );
        form.documentUploadInspection.uploadAttempted = form.documentUploadVerification.status === 'attached';
        form.documentUploadInspection.uploadOutcome = form.documentUploadVerification.status === 'attached'
          ? 'attached-and-verified'
          : 'blocked-before-upload';
        form.documentUploadInspection.uatSyntheticUploadPermission = process.env.TEST_EKYC_SYNTHETIC_FIXTURE_APPROVED === 'true'
          ? 'explicit-test-environment-approval'
          : 'not-established';
        const currentStep = Number(form.tracker.currentStep);
        form.documentUploadInspection.trackerProgression = {
          fromStep: Number.isFinite(currentStep) ? currentStep : form.tracker.currentStep,
          expectedNextStep: Number.isFinite(currentStep) ? currentStep + 1 : null,
          currentStep: Number.isFinite(currentStep) ? currentStep : form.tracker.currentStep,
          confirmed: false,
          reason: form.documentUploadVerification.status === 'attached'
            ? 'Submission and tracker progression have not yet been attempted.'
            : form.documentUploadVerification.reason,
        };
        addDecisionTrace(report, {
          decision: 'inspect-ekyc-upload-controls',
          evidence: {
            documentTypeLabelObserved: form.documentUploadInspection.documentTypeLabelObserved,
            options: form.documentUploadInspection.options,
            committedDocumentTypes: form.documentUploadInspection.committedDocumentTypes,
            documentInstructions: form.documentUploadInspection.documentInstructions,
            fileInputs: form.documentUploadInspection.fileInputs,
            fixture: form.documentUploadInspection.fixture,
            uatSyntheticUploadPermission: form.documentUploadInspection.uatSyntheticUploadPermission,
            uploadVerification: form.documentUploadVerification,
          },
          action: form.documentUploadVerification.status === 'attached'
            ? 'Associated each file input with its Form.io field key, used setInputFiles with the approved synthetic UAT PNG, and verified the visible attachment and validation state.'
            : 'Inspected each required file input and Form.io association; no file was attached and Continue was not clicked.',
          reason: form.documentUploadVerification.reason || 'All three approved synthetic UAT attachments were visible and valid.',
          result: form.documentUploadVerification.status === 'attached'
            ? 'All required attachments were verified; submission may proceed.'
            : 'Upload was safely blocked at the reported field.',
          retries: 0,
          unresolved: form.documentUploadVerification.status === 'attached'
            ? []
            : [form.documentUploadVerification.reason],
        });
      }
      const postDecisionForm = await inspectDynamicForm(page);
      Object.assign(form, postDecisionForm, {
        prefilledFieldVerification: form.prefilledFieldVerification,
        nationalityDataComparison: form.nationalityDataComparison,
        dropdownOptionDiscovery: form.dropdownOptionDiscovery,
        conditionalBehavior: form.conditionalBehavior,
        documentUploadInspection: form.documentUploadInspection,
        documentUploadVerification: form.documentUploadVerification,
      });

      const snapshot = {
        sequence: stepIndex + 1,
        url: form.url,
        formTitle: form.stepTitle,
        tracker: form.tracker,
        form,
        fieldHandling: buildFieldHandling(initialFields, form.fields),
        submission: null,
      };
      report.steps.push(snapshot);
      writeProgressReport(report);

      const visibleText = await page.locator('body').innerText();
      const completion = onboardingCompletionEvidence(visibleText, form.tracker);
      if (completion.verified) {
        report.finalCompletionVerified = true;
        report.completionEvidence = {
          observedText: completion.excerpt,
          verification: completion.evidence,
          url: form.url,
        };
        break;
      }

      const declarationWait = await waitForUserDeclarations(page, form);
      if (!declarationWait.completed) {
        logFieldStatus('BLOCKED', declarationWait.fields[0]?.field || 'Personal declaration', declarationWait.reason);
        report.blocker = {
          step: Number(form.tracker.currentStep) || stepIndex + 1,
          visitSequence: stepIndex + 1,
          title: form.stepTitle,
          kind: 'required-user-declaration-not-completed',
          tracker: form.tracker,
          reason: declarationWait.reason,
          details: declarationWait.fields,
          status: 'Stopped before filling or submitting; the user did not complete the required truthful declaration.',
        };
        snapshot.userDecisionCheckpoint = {
          status: 'blocked',
          fields: declarationWait.fields,
        };
        writeProgressReport(report);
        break;
      }
      if (declarationWait.fields.length) {
        const discovery = form.dropdownOptionDiscovery;
        const conditionalBehavior = form.conditionalBehavior;
        Object.assign(form, declarationWait.form, {
          dropdownOptionDiscovery: discovery,
          conditionalBehavior,
        });
        snapshot.form = form;
        snapshot.fieldHandling = buildFieldHandling(initialFields, form.fields);
        snapshot.userDecisionCheckpoint = {
          status: 'user-values-verified',
          fields: declarationWait.fields,
        };
        for (const field of declarationWait.fields) {
          logFieldStatus('PASS', field.field, 'User-entered value is present and has no visible validation error; value omitted from logs.');
        }
        writeProgressReport(report);
      }

      const blockers = findSafetyBlockers(form, visibleText);
      if (blockers.length) {
        const documentUploadBlocked = blockers.some(blocker => blocker.kind === 'document-upload-requires-approved-test-fixture');
        if (documentUploadBlocked) {
          for (const handling of snapshot.fieldHandling) {
            if (handling.controlType === 'file') {
              handling.status = 'blocked';
              handling.reason = 'A document fixture requires explicit approved QA data; no file was attached.';
            }
          }
          logUploadVerification(form.documentUploadVerification);
        } else {
          for (const blocker of blockers) {
            const fieldLabel = blocker.field || blocker.failedField || blocker.kind;
            logFieldStatus('BLOCKED', fieldLabel, blocker.reason);
          }
        }
        report.blocker = {
          step: Number(form.tracker.currentStep) || stepIndex + 1,
          visitSequence: stepIndex + 1,
          title: form.stepTitle,
          kind: documentUploadBlocked ? 'approved-ekyc-fixture-unavailable' : 'unresolved-user-decision',
          tracker: form.tracker,
          reason: documentUploadBlocked
            ? form.documentUploadVerification.reason
            : 'The current step requires a human decision or contains a field that cannot be safely completed with synthetic data.',
          details: blockers,
          status: 'Stopped before filling or submitting this step.',
        };
        break;
      }

      const fillResult = await fillSafeSyntheticFields(page, form, { residenceCountry: TEST_RESIDENCE_COUNTRY });
      report.syntheticDataCategoriesUsed.push(...fillResult.used);
      const afterFillForm = await inspectDynamicForm(page);
      snapshot.fieldHandling = buildFieldHandling(initialFields, afterFillForm.fields);
      for (const handling of snapshot.fieldHandling) {
        const synthetic = fillResult.used.find(item => item.field === handling.field);
        if (synthetic && handling.status === 'populated') handling.syntheticDataCategory = synthetic.category;
      }
      const decisionFieldLabels = {
        'residence-country': 'Country',
        'date-of-birth': 'Date of Birth',
        gender: 'Gender',
      };
      const fieldIssues = [
        ...stepDecisions.flatMap(event => event.unresolved.map(reason => ({
          field: decisionFieldLabels[event.decision] || event.decision,
          reason,
        }))),
        ...fillResult.unresolvedRequired,
      ];
      logFieldHandling(snapshot.fieldHandling, [], fieldIssues);
      const decisionBlockers = stepDecisions
        .flatMap(event => event.unresolved.map(reason => ({
          decision: event.decision,
          reason,
        })));
      if (decisionBlockers.length) {
        report.blocker = {
          step: stepIndex + 1,
          title: form.stepTitle,
          kind: 'approved-decision-or-control-unresolved',
          details: [
            ...decisionBlockers,
            ...fillResult.unresolvedRequired.map(issue => ({ decision: 'required-field', ...issue })),
          ],
          status: 'Safe synthetic fields were handled, but submission was stopped because a required choice or valid control state was unresolved.',
        };
        break;
      }
      if (fillResult.unresolvedRequired.length) {
        report.blocker = {
          step: stepIndex + 1,
          title: form.stepTitle,
          kind: 'required-field-not-safely-resolvable',
          details: fillResult.unresolvedRequired,
          status: 'Stopped before submitting; no synthetic value or option was invented.',
        };
        break;
      }

      const refreshedForm = afterFillForm;
      Object.assign(form, refreshedForm, {
        prefilledFieldVerification: form.prefilledFieldVerification,
        nationalityDataComparison: form.nationalityDataComparison,
        dropdownOptionDiscovery: form.dropdownOptionDiscovery,
        conditionalBehavior: form.conditionalBehavior,
      });
      snapshot.fieldHandling = buildFieldHandling(initialFields, refreshedForm.fields);

      const action = form.controls.find(control => /continue|save|submit/i.test(control.label || '') && control.enabled);
      if (!action) {
        logFieldStatus('FAIL', 'Form submitted', 'No visible enabled Continue, Save, or Submit control was found.');
        report.blocker = {
          step: stepIndex + 1,
          title: form.stepTitle,
          kind: 'no-enabled-submit-control',
          details: [{ reason: 'No visible enabled Continue, Save, or Submit control was found.' }],
        };
        break;
      }

      const actionButton = page.getByRole('button', { name: action.label, exact: true });
      if (!await actionButton.isVisible()) {
        logFieldStatus('FAIL', 'Form submitted', 'The observed submit control did not resolve to a visible button.');
        report.blocker = {
          step: stepIndex + 1,
          title: form.stepTitle,
          kind: 'submit-action-not-button',
          details: [{ reason: 'Visible action metadata did not resolve to a visible button; no alternate submit mechanism was attempted.' }],
        };
        break;
      }

      snapshot.submissionAttempts = [];
      const maximumAttempts = 3;
      let acceptedStep = false;
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        const beforeAttempt = await inspectDynamicForm(page);
        await actionButton.click();
        const postSubmitUi = await waitForPostSubmitUi(page, beforeAttempt);
        const afterForm = postSubmitUi.form;
        const afterVisibleText = await page.locator('body').innerText();
        const completion = onboardingCompletionEvidence(afterVisibleText, afterForm.tracker);
        const completionNowVisible = completion.verified;
        const validationErrors = [
          ...afterForm.validationMessages.map(message => ({ field: null, message })),
          ...afterForm.fields
            .filter(field => field.ariaInvalid || field.validationMessage)
            .map(field => ({ field: field.label || field.id || field.name || null, message: field.validationMessage || 'aria-invalid is true' })),
        ];
        const observedValidationRequirements = recordObservedRequiredness(afterForm, validationErrors);
        const expectedNextStep = Number(beforeAttempt.tracker.currentStep) + 1;
        const trackerAdvanced = Number.isFinite(expectedNextStep)
          && Number(afterForm.tracker.currentStep) === expectedNextStep
          && Number(afterForm.tracker.totalSteps) === Number(beforeAttempt.tracker.totalSteps);
        const attemptRecord = {
          attempt,
          action: action.label,
          urlBefore: beforeAttempt.url,
          resultingUrl: afterForm.url,
          resultingFormTitle: afterForm.stepTitle,
          trackerBefore: beforeAttempt.tracker,
          resultingTracker: afterForm.tracker,
          postSubmitUiChanged: postSubmitUi.changed,
          postSubmitUiWaitMs: postSubmitUi.waitedMs,
          validationErrors,
          observedValidationRequirements,
          outcome: completionNowVisible ? 'completion-visible'
            : validationErrors.length ? 'validation-rejected'
              : trackerAdvanced ? 'tracker-advanced'
                : 'tracker-progression-unconfirmed',
          resultingFormMetadata: afterForm,
          corrections: [],
        };
        snapshot.submissionAttempts.push(attemptRecord);
        report.submissionOutcomes.push(attemptRecord);
        report.finalTracker = afterForm.tracker;
        report.transitions.push({
          step: stepIndex + 1,
          attempt,
          from: {
            url: beforeAttempt.url,
            title: beforeAttempt.stepTitle,
            tracker: beforeAttempt.tracker,
          },
          to: {
            url: afterForm.url,
            title: afterForm.stepTitle,
            tracker: afterForm.tracker,
          },
          progressConfirmed: trackerAdvanced || completionNowVisible,
          outcome: attemptRecord.outcome,
        });
        const beforePosition = pagePosition(beforeAttempt, stepIndex + 1);
        const afterPosition = pagePosition(afterForm, stepIndex + 1);
        if (completionNowVisible) {
          logFieldStatus('PASS', 'Form submitted');
          logFieldStatus('PASS', 'Completion confirmed', completion.evidence);
        } else if (validationErrors.length) {
          const fieldErrors = validationErrors.filter(error => error.field);
          for (const error of fieldErrors) logFieldStatus('FAIL', error.field, error.message);
          for (const error of validationErrors.filter(item => !item.field)) {
            logFieldStatus('FAIL', 'Form submitted', `Page ${beforePosition.current}/${beforePosition.total}: ${error.message}`);
          }
        } else if (trackerAdvanced) {
          logFieldStatus('PASS', 'Form submitted');
          logFieldStatus('PASS', `Advanced to Page ${afterPosition.current}/${afterPosition.total}`);
        } else {
          const reason = afterForm.validationMessages?.length
            ? afterForm.validationMessages.join('; ')
            : `Visible tracker remained at ${beforePosition.current}/${beforePosition.total}; no submission or validation message was visible.`;
          logFieldStatus('FAIL', 'Form submitted', `Page ${beforePosition.current}/${beforePosition.total}: ${reason}`);
        }
        writeProgressReport(report);

        if (completionNowVisible) {
          snapshot.submission = attemptRecord;
          report.finalCompletionVerified = true;
          report.completionEvidence = {
            observedText: completion.excerpt,
            verification: completion.evidence,
            url: afterForm.url,
            tracker: afterForm.tracker,
          };
          acceptedStep = true;
          break;
        }

        if (validationErrors.length) {
          afterForm.dropdownOptionDiscovery = await discoverDropdownOptions(page, afterForm);
          const correctionResult = await fillSafeSyntheticFields(
            page,
            afterForm,
            { residenceCountry: TEST_RESIDENCE_COUNTRY },
            validationErrors,
          );
          report.syntheticDataCategoriesUsed.push(...correctionResult.used);
          attemptRecord.corrections = correctionResult.used;
          report.validationErrorsAndCorrections.push({
            step: stepIndex + 1,
            attempt,
            errors: validationErrors,
            observedRequiredness: observedValidationRequirements,
            corrections: correctionResult.used,
            retryCount: attempt - 1,
            unresolvedRequired: correctionResult.unresolvedRequired,
            status: correctionResult.unresolvedRequired.length
              ? 'Stopped because unresolved required fields cannot be answered safely.'
              : correctionResult.used.length && attempt < maximumAttempts
                ? 'Applied observed-rule corrections; one bounded retry will follow.'
                : 'No safe corrective action remains or the three-attempt bound was reached.',
          });
          if (!correctionResult.unresolvedRequired.length && correctionResult.used.length && attempt < maximumAttempts) continue;
          snapshot.submission = attemptRecord;
          report.blocker = {
            step: stepIndex + 1,
            title: form.stepTitle,
            kind: 'validation-rejected-with-unresolved-rule',
            details: [...validationErrors, ...correctionResult.unresolvedRequired],
            attempts: attempt,
            maximumAttempts,
          };
          break;
        }

        if (!trackerAdvanced) {
          snapshot.submission = attemptRecord;
          report.blocker = {
            step: stepIndex + 1,
            title: form.stepTitle,
            kind: 'tracker-progression-unconfirmed',
            details: [{
              expectedCurrentStep: expectedNextStep,
              observedCurrentStep: afterForm.tracker.currentStep,
              observedTotalSteps: afterForm.tracker.totalSteps,
              reason: 'A click or changed UI alone is insufficient; the tracker did not confirm advancement to the next step.',
            }],
          };
          break;
        }

        snapshot.submission = attemptRecord;
        acceptedStep = true;
        report.lastCompletedStage = {
          step: stepIndex + 1,
          title: form.stepTitle,
          tracker: afterForm.tracker,
        };
        break;
      }
      if (report.finalCompletionVerified) break;
      if (acceptedStep && page.url().includes('/onboarding')) continue;
      if (!report.blocker) {
        report.blocker = {
          step: stepIndex + 1,
          title: form.stepTitle,
          kind: 'maximum-submission-attempts-reached',
          details: [{ maximumAttempts }],
        };
      }
      break;
    }

    if (!report.finalCompletionVerified && !report.blocker) {
      report.blocker = {
        kind: 'maximum-step-bound-reached',
        details: [{ reason: `No completion state was observed within the safety bound of ${MAX_STEP_VISITS} distinct step visits.` }],
      };
    }

    report.factsVsInferences.push(
      { type: 'observed', detail: 'Only the rendered Individual onboarding route, visible fields, tracker, and UI outcomes are reported as facts.' },
      { type: 'inference', detail: 'No business meaning is inferred from unlabeled controls, option values, or selection labels.' },
    );

    const serialized = await persistReport(report, testInfo);
    expect(report.steps.length, 'At least one onboarding step must be inspected').toBeGreaterThan(0);
    if (!report.blocker) {
      expect(report.submissionOutcomes.length, 'The onboarding flow must submit at least one form').toBeGreaterThan(0);
    }
    const completedPages = Number(report.lastCompletedStage?.step || 0);
    const totalPages = Number(report.finalTracker?.totalSteps || report.initialTracker?.totalSteps || 6);
    const failedPage = Number(report.blocker?.step || report.finalTracker?.currentStep || completedPages + 1);
    const blockerDetails = Array.isArray(report.blocker?.details) ? report.blocker.details : [];
    const failedField = report.blocker?.failedField
      || blockerDetails.find(detail => detail.failedField)?.failedField
      || blockerDetails.find(detail => detail.field)?.field
      || 'Not field-specific';
    const failureReason = blockerDetails.find(detail => detail.message)?.message
      || blockerDetails.find(detail => detail.validationMessage)?.validationMessage
      || blockerDetails.find(detail => detail.reason)?.reason
      || report.blocker?.reason
      || 'No visible completion confirmation was observed.';
    console.log('\n=== FINAL RESULT ===');
    console.log(`Pages completed: ${completedPages}/${totalPages}`);
    console.log(`Status: ${report.finalCompletionVerified ? 'PASS' : 'BLOCKED'}`);
    if (report.finalCompletionVerified) {
      console.log('Completion: visible application completion state verified.');
    } else {
      console.log(`Failed page: ${failedPage}/${totalPages}`);
      console.log(`Failed field: ${redactText(failedField)}`);
      console.log(`Reason: ${redactText(failureReason)}`);
    }
    expect(
      report.finalCompletionVerified,
      report.finalCompletionVerified
        ? 'Onboarding completion state was not verified.'
        : `Onboarding BLOCKED at page ${failedPage}/${totalPages}, field ${redactText(failedField)}: ${redactText(failureReason)}`,
    )
      .toBe(true);
    return report;
}

module.exports = {
  attachApprovedEkycFixture,
  fillSafeSyntheticFields,
  runOnboardingAutomation,
  waitForUserDeclarations,
  waitForOnboardingStepSurface,
};
