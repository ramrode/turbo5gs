/*
 * CHF subscriber quota profile — Redux-connected document container.
 *
 * Responsibilities:
 *   1. Fetch an existing ChfSubscriber document from the REST API when editing.
 *   2. Convert raw byte values stored in MongoDB → human-readable display form
 *      for Edit.js (dbToForm: totalQuotaBytes → totalVolume + volumeUnit).
 *   3. Convert the form's display values → raw bytes + canonical seconds before
 *      persisting (formToDb), so the Mongoose model and C db-handler.c always
 *      see consistent totalQuotaBytes / validitySeconds fields.
 *   4. Dispatch create / update actions and show success / error notifications.
 *
 * Unit conversion (binary prefixes, IEC 80000-13):
 *   1 MB = 1 048 576 bytes   (2^20)
 *   1 GB = 1 073 741 824 bytes (2^30)
 *   1 TB = 1 099 511 627 776 bytes (2^40)
 *
 * 3GPP: TS 23.255 §5.2   — CHF subscriber management
 *       TS 32.291 §6.3.1 — ChargingDataRequest: grantedUnit drives the quota
 *       TS 32.291 §6.3.2.2 — TIME_LIMIT / VOLUME_LIMIT triggers
 */

import { Component } from 'react';
import PropTypes from 'prop-types';
import { connect } from 'react-redux';
import { isEqual } from 'lodash/lang';

import NProgress from 'nprogress';

import {
  MODEL,
  fetchChfSubscriber,
  createChfSubscriber,
  updateChfSubscriber,
} from 'modules/crud/chf-subscriber';
import { clearActionStatus } from 'modules/crud/actions';
import { select, selectActionStatus } from 'modules/crud/selectors';
import * as Notification from 'modules/notification/actions';

import { ChfSubscriber } from 'components';
import {
  DEFAULT_QUOTA_FORM as defaultFormData,
  dbToForm,
  formToDb,
} from 'helpers/chf-quota-convert';

/* ------------------------------------------------------------------ */
/* Document container                                                   */
/* ------------------------------------------------------------------ */
class Document extends Component {
  static propTypes = {
    action: PropTypes.string,
    visible: PropTypes.bool,
    onHide: PropTypes.func,
  };

  state = {
    formData: defaultFormData,
  };

  componentWillMount() {
    const { chfSubscriber, dispatch } = this.props;
    if (chfSubscriber.needsFetch) {
      dispatch(chfSubscriber.fetch);
    }
  }

  componentWillReceiveProps(nextProps) {
    const { chfSubscriber, status } = nextProps;
    const { dispatch, action, onHide } = this.props;

    if (chfSubscriber.needsFetch) {
      dispatch(chfSubscriber.fetch);
    }

    /*
     * Convert raw bytes from DB → display unit for the form.
     * dbToForm() handles both the new totalQuotaBytes field and legacy
     * volumeUlBytes + volumeDlBytes (backward compat with older records).
     *
     * Only load the form when the modal opens or the document behind it
     * actually changes.  Both CHF pages poll on a timer, so every few
     * seconds an unrelated store update re-renders this connected component;
     * resetting formData unconditionally would discard whatever the operator
     * had typed mid-edit.
     */
    const nextForm = chfSubscriber.data
      ? dbToForm(chfSubscriber.data)
      : defaultFormData;

    if ((nextProps.visible && !this.props.visible) ||
        !isEqual(nextForm, this.loadedForm)) {
      this.loadedForm = nextForm;
      this.setState({ formData: nextForm });
    }

    if (status.response) {
      NProgress.configure({ parent: 'body', trickleSpeed: 5 });
      NProgress.done(true);

      const message =
        action === 'create'
          ? 'New CHF quota profile created'
          : `${status.id} quota profile updated`;

      dispatch(Notification.success({ title: 'CHF Quota', message }));
      dispatch(clearActionStatus(MODEL, action));
      onHide();
    }

    if (status.error) {
      NProgress.configure({ parent: 'body', trickleSpeed: 5 });
      NProgress.done(true);

      const response = ((status || {}).error || {}).response || {};
      let title = 'Unknown Code';
      let message = 'Unknown Error';
      if (response.data && response.data.name && response.data.message) {
        title = response.data.name;
        message = response.data.message;
      } else {
        title = response.status;
        message = response.statusText;
      }

      dispatch(
        Notification.error({
          title,
          message,
          autoDismiss: 0,
          action: { label: 'Dismiss', callback: () => onHide() },
        })
      );
      dispatch(clearActionStatus(MODEL, action));
    }
  }

  handleSubmit = formData => {
    const { dispatch, action } = this.props;

    NProgress.configure({ parent: '#nprogress-base-form', trickleSpeed: 5 });
    NProgress.start();

    /*
     * Convert display-unit fields (totalVolume, volumeUnit, validityPeriod)
     * to raw bytes (totalQuotaBytes) and canonical seconds (validitySeconds)
     * before persisting.  This keeps the Mongoose model schema consistent and
     * ensures db-handler.c reads the correct camelCase field names.
     */
    const dbData = formToDb(formData);

    if (action === 'create') {
      dispatch(createChfSubscriber({}, dbData));
    } else if (action === 'update') {
      dispatch(updateChfSubscriber(dbData.bucketId || dbData.supi, {}, dbData));
    } else {
      throw new Error(`Action type '${action}' is invalid.`);
    }
  };

  handleError = errors => {
    const { dispatch } = this.props;
    errors.map(error =>
      dispatch(
        Notification.error({ title: 'Validation Error', message: error.stack })
      )
    );
  };

  render() {
    const { handleSubmit, handleError } = this;
    const { visible, action, status, chfSubscriber, onHide } = this.props;

    return (
      <ChfSubscriber.Edit
        visible={visible}
        action={action}
        formData={this.state.formData}
        isLoading={chfSubscriber.isLoading && !status.pending}
        onHide={onHide}
        onSubmit={handleSubmit}
        onError={handleError}
      />
    );
  }
}

Document = connect((state, props) => ({
  chfSubscriber: select(fetchChfSubscriber(props.bucketId || props.supi),
      state.crud),
  status: selectActionStatus(MODEL, state.crud, props.action),
}))(Document);

export default Document;
