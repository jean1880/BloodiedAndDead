const ACCEPTED_VALUES = ["bar1", "bar2", "bar3"];
let barValue = "bar3"; // this value determines which bar your script will be watching

// event listeners
log(`Binding health watcher to ${barValue}`);
on('chat:message', onMessage);
on(`change:graphic:${barValue}_value`, onGraphicChange);

/**
 * Chat message interface to change the target bar for this instance, caution does not 
 * retain state
 * @param {Object} msg - Roll20 Message object
 */
function onMessage(msg) {
    if (msg.type == 'api' && msg.content.indexOf('!ChangeBar') !== -1) {
        let message = msg.content.split(" ")[1];
        
        log("Message: " + message);
        if (ACCEPTED_VALUES.includes(message)) {
            barValue = message;
            log("Blood and Dead bar value changed to " + message);
        }
    }
}

/**
 * Checks the specified <barValue>_value and determins if the marker should be updated.
 * Adds a red dot when below the specified threshold, and crosses out the token if the 
 * value drops at or below zero
 * @param {Object} obj - Roll20 Graphic object
 */
function onGraphicChange(obj) {
    log('Check hit dice');
    if(obj.get(`${barValue}_max`) === "") return;
   
    // checks if the value is at or below the threshold, and adds a red dot if true, removes if not
    if(obj.get(`${barValue}_value`) <= obj.get(`${barValue}_max`) / 2) {
        obj.set({
              status_redmarker: true
        });
    }
    else{
        obj.set({
            status_redmarker: false
        })
    }

    // If value is at or below zero, set the status to dead
    if(obj.get(`${barValue}_value`) <= 0) {
      obj.set({
         status_dead: true
      });
    }
    else {
      obj.set({
        status_dead: false
      });
    }
}